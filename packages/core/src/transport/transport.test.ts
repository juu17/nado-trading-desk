import { describe, it, expect, vi } from "vitest";
import { RateLimiter } from "../ratelimit/limiter.js";
import { MeteredTransport } from "./transport.js";
import type { RateLimitSpec } from "@farm/adapter-api";

const SPEC: RateLimitSpec[] = [{ bucket: "rest", scope: "ip", algo: "token-bucket", capacity: 2, windowMs: 1000 }];

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

class FakeWS {
  readyState = 1; // OPEN
  private listeners: Record<string, Array<() => void>> = {};
  addEventListener(e: string, cb: () => void): void { (this.listeners[e] ??= []).push(cb); }
  close(): void { this.readyState = 3; (this.listeners.close ?? []).forEach((f) => f()); }
  send(): void {}
}

describe("MeteredTransport", () => {
  it("meters, performs the request, and parses JSON", async () => {
    const limiter = new RateLimiter({ now: () => 0 }).register(SPEC);
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: 1 }));
    const tx = new MeteredTransport({ limiter, fetchFn: fetchFn as unknown as typeof fetch });
    const out = await tx.request<{ ok: number }>({ bucket: "rest", scope: "ip", weight: 1, method: "POST", url: "https://x/y", body: { a: 1 } });
    expect(out).toEqual({ ok: 1 });
    expect(fetchFn).toHaveBeenCalledOnce();
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect(limiter.available("rest")).toBe(1); // one token consumed
  });

  it("maps HTTP 429 to a rate-limited AdapterError with retry-after", async () => {
    const limiter = new RateLimiter().register(SPEC);
    const fetchFn = vi.fn(async () => jsonResponse({}, 429, { "retry-after": "2" }));
    const tx = new MeteredTransport({ limiter, fetchFn: fetchFn as unknown as typeof fetch });
    await expect(tx.request({ bucket: "rest", scope: "ip", weight: 1, method: "GET", url: "https://x" }))
      .rejects.toMatchObject({ category: "rate-limited", retryAfterMs: 2000 });
  });

  it("maps 5xx → retryable-unsafe and 4xx → rejected", async () => {
    const limiter = new RateLimiter().register(SPEC);
    const mk = (status: number) => new MeteredTransport({ limiter, fetchFn: (async () => jsonResponse({}, status)) as unknown as typeof fetch });
    await expect(mk(503).request({ bucket: "rest", scope: "ip", weight: 1, method: "GET", url: "u" })).rejects.toMatchObject({ category: "retryable-unsafe" });
    await expect(mk(400).request({ bucket: "rest", scope: "ip", weight: 1, method: "GET", url: "u" })).rejects.toMatchObject({ category: "rejected" });
  });

  it("pools sockets per URL and reopens after close", () => {
    const limiter = new RateLimiter();
    let made = 0;
    const factory = (): WebSocket => { made++; return new FakeWS() as unknown as WebSocket; };
    const tx = new MeteredTransport({ limiter, socketFactory: factory });
    const a = tx.openSocket({ url: "wss://s", bucket: "ws" });
    const b = tx.openSocket({ url: "wss://s", bucket: "ws" });
    expect(made).toBe(1);
    expect(a).toBe(b);
    (a as unknown as FakeWS).close(); // close listener evicts it from the pool
    tx.openSocket({ url: "wss://s", bucket: "ws" });
    expect(made).toBe(2);
  });
});
