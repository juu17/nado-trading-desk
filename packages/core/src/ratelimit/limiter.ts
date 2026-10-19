// =============================================================================
// @farm/core · rate limiter — token-bucket + sliding-window, from manifest/chain
// RateLimitSpecs. This is a genuine core addition (wative has no rate metering):
// it rations 1000 wallets sharing one egress IP against per-IP / per-subaccount /
// per-chain buckets. The clock + sleep are injectable so the algorithms are
// unit-tested deterministically (no real timers).
// =============================================================================
import type { RateLimitSpec } from "@farm/adapter-api";

export interface RateLimiterDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface PeekResult { ok: boolean; retryAfterMs: number }

interface Limitable {
  readonly max: number;
  peek(weight: number, now: number): PeekResult;
  consume(weight: number, now: number): void;
  available(now: number): number;
}

/** Token bucket: refills continuously at capacity/windowMs tokens per ms. */
class TokenBucketLim implements Limitable {
  readonly max: number;
  private tokens: number;
  private last: number;
  constructor(private readonly cap: number, private readonly windowMs: number, now: number) {
    this.tokens = cap; this.last = now; this.max = cap;
  }
  private refill(now: number): void {
    if (now > this.last) {
      this.tokens = Math.min(this.cap, this.tokens + ((now - this.last) / this.windowMs) * this.cap);
      this.last = now;
    }
  }
  peek(weight: number, now: number): PeekResult {
    this.refill(now);
    if (this.tokens >= weight) return { ok: true, retryAfterMs: 0 };
    const deficit = weight - this.tokens;
    return { ok: false, retryAfterMs: Math.ceil((deficit * this.windowMs) / this.cap) };
  }
  consume(weight: number, now: number): void { this.refill(now); this.tokens -= weight; }
  available(now: number): number { this.refill(now); return Math.floor(this.tokens); }
}

/** Sliding window: at most `cap` hits within any trailing `windowMs`. */
class SlidingWindowLim implements Limitable {
  readonly max: number;
  private hits: number[] = [];
  constructor(private readonly cap: number, private readonly windowMs: number) { this.max = cap; }
  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.hits.length > 0 && (this.hits[0] as number) <= cutoff) this.hits.shift();
  }
  peek(weight: number, now: number): PeekResult {
    this.prune(now);
    if (this.hits.length + weight <= this.cap) return { ok: true, retryAfterMs: 0 };
    const need = this.hits.length + weight - this.cap; // how many must expire
    const idx = need - 1;
    const ref = idx >= 0 && idx < this.hits.length ? (this.hits[idx] as number) : now;
    return { ok: false, retryAfterMs: Math.max(1, ref + this.windowMs - now) };
  }
  consume(weight: number, now: number): void { this.prune(now); for (let i = 0; i < weight; i++) this.hits.push(now); }
  available(now: number): number { this.prune(now); return Math.max(0, this.cap - this.hits.length); }
}

/** A bucket = the main limiter + an optional burst limiter; a grant needs BOTH. */
class BucketGroup {
  constructor(private readonly lims: readonly Limitable[]) {}
  get max(): number { return Math.min(...this.lims.map((l) => l.max)); }
  tryConsume(weight: number, now: number): PeekResult {
    const peeks = this.lims.map((l) => l.peek(weight, now));
    const failed = peeks.filter((p) => !p.ok);
    if (failed.length === 0) {
      for (const l of this.lims) l.consume(weight, now);
      return { ok: true, retryAfterMs: 0 };
    }
    return { ok: false, retryAfterMs: Math.max(...failed.map((p) => p.retryAfterMs)) };
  }
  available(now: number): number { return Math.min(...this.lims.map((l) => l.available(now))); }
}

function makeLim(algo: RateLimitSpec["algo"], cap: number, windowMs: number, now: number): Limitable {
  return algo === "sliding-window" ? new SlidingWindowLim(cap, windowMs) : new TokenBucketLim(cap, windowMs, now);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class RateLimiter {
  private readonly specs = new Map<string, RateLimitSpec>();
  private readonly groups = new Map<string, BucketGroup>();
  constructor(private readonly deps: RateLimiterDeps = {}) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private sleep(ms: number): Promise<void> { return (this.deps.sleep ?? defaultSleep)(ms); }

  /** Register bucket definitions (idempotent; later specs for a bucket replace earlier). */
  register(specs: readonly RateLimitSpec[]): this {
    for (const s of specs) this.specs.set(s.bucket, s);
    return this;
  }
  has(bucket: string): boolean { return this.specs.has(bucket); }

  private groupFor(bucket: string, key: string | undefined, spec: RateLimitSpec): BucketGroup {
    const gkey = `${bucket}|${key ?? "*"}`;
    let g = this.groups.get(gkey);
    if (!g) {
      const now = this.now();
      const lims: Limitable[] = [makeLim(spec.algo, spec.capacity, spec.windowMs, now)];
      if (spec.burst) lims.push(makeLim("token-bucket", spec.burst.capacity, spec.burst.windowMs, now));
      g = new BucketGroup(lims);
      this.groups.set(gkey, g);
    }
    return g;
  }

  /** Non-blocking: consume `weight` now, or return false. Unregistered buckets pass. */
  tryAcquire(bucket: string, weight = 1, key?: string): boolean {
    const spec = this.specs.get(bucket);
    if (!spec) return true;
    return this.groupFor(bucket, key, spec).tryConsume(weight, this.now()).ok;
  }

  /** Blocking: wait (via injected sleep) until `weight` is available, then consume. */
  async acquire(bucket: string, weight = 1, key?: string, signal?: AbortSignal): Promise<void> {
    const spec = this.specs.get(bucket);
    if (!spec) return; // unregistered → unlimited pass-through
    const group = this.groupFor(bucket, key, spec);
    if (weight > group.max) throw new Error(`rate weight ${weight} exceeds bucket '${bucket}' capacity ${group.max}`);
    for (;;) {
      if (signal?.aborted) throw new Error("rate acquire aborted");
      const r = group.tryConsume(weight, this.now());
      if (r.ok) return;
      await this.sleep(Math.max(1, r.retryAfterMs));
    }
  }

  /** Current spare capacity for a bucket/key (Infinity if unregistered). */
  available(bucket: string, key?: string): number {
    const spec = this.specs.get(bucket);
    if (!spec) return Infinity;
    return this.groupFor(bucket, key, spec).available(this.now());
  }
}
