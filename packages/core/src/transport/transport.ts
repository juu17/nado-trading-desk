// =============================================================================
// @farm/core · metered transport — the concrete AdapterEnv.request + openSocket.
// Every HTTP call passes the RateLimiter first (per bucket/scope/key); WebSockets
// are pooled per URL (the manifest's streams are many-subjects-per-conn). HTTP
// failures normalize to the seam AdapterError the retry logic branches on.
// fetch + socket factory are injectable so it is unit-tested with no network.
// =============================================================================
import type { RateScope, AdapterError } from "@farm/adapter-api";
import type { RateLimiter } from "../ratelimit/limiter.js";

export interface MeteredRequest {
  bucket: string;
  scope: RateScope;
  weight: number;
  key?: string;
  method: "GET" | "POST";
  url: string;
  body?: unknown;
  signal?: AbortSignal;
}

export interface MeteredTransportDeps {
  limiter: RateLimiter;
  fetchFn?: typeof fetch;
  socketFactory?: (url: string) => WebSocket;
  headers?: Readonly<Record<string, string>>;
}

function httpError(category: AdapterError["category"], status: number, retryAfterMs?: number): AdapterError {
  return {
    category,
    retrySafe: category === "retryable-safe",
    message: `HTTP ${status}`,
    code: String(status),
    retryAfterMs,
    raw: { status },
  };
}

export class MeteredTransport {
  private readonly sockets = new Map<string, WebSocket>();
  constructor(private readonly deps: MeteredTransportDeps) {}

  async request<T>(a: MeteredRequest): Promise<T> {
    await this.deps.limiter.acquire(a.bucket, a.weight, a.key, a.signal);
    const fetchFn = this.deps.fetchFn ?? fetch;
    const res = await fetchFn(a.url, {
      method: a.method,
      headers: { "content-type": "application/json", ...this.deps.headers },
      body: a.body != null ? JSON.stringify(a.body) : undefined,
      signal: a.signal,
    });
    if (res.status === 429) throw httpError("rate-limited", res.status, retryAfter(res));
    if (!res.ok) throw httpError(res.status >= 500 ? "retryable-unsafe" : "rejected", res.status);
    return (await res.json()) as T;
  }

  /** Pooled socket per URL — returns the live one, or opens + tracks a new one. */
  openSocket(s: { url: string; bucket: string }): WebSocket {
    const existing = this.sockets.get(s.url);
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return existing;
    }
    const factory = this.deps.socketFactory ?? ((url: string) => new WebSocket(url));
    const ws = factory(s.url);
    this.sockets.set(s.url, ws);
    ws.addEventListener("close", () => { if (this.sockets.get(s.url) === ws) this.sockets.delete(s.url); });
    return ws;
  }

  closeAll(): void {
    for (const ws of this.sockets.values()) ws.close();
    this.sockets.clear();
  }
}

function retryAfter(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  return Number.isFinite(secs) ? secs * 1000 : undefined;
}
