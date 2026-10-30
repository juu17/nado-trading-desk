import { describe, it, expect } from "vitest";
import { RateLimiter } from "./limiter.js";

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("RateLimiter", () => {
  it("token-bucket: capacity, refusal, full refill, weighted consume", () => {
    const c = clock();
    const rl = new RateLimiter({ now: c.now }).register([{ bucket: "b", scope: "ip", algo: "token-bucket", capacity: 3, windowMs: 1000 }]);
    expect(rl.tryAcquire("b")).toBe(true);
    expect(rl.tryAcquire("b")).toBe(true);
    expect(rl.tryAcquire("b")).toBe(true);
    expect(rl.tryAcquire("b")).toBe(false); // exhausted
    c.advance(1000);
    expect(rl.available("b")).toBe(3);      // fully refilled
    expect(rl.tryAcquire("b", 3)).toBe(true); // weighted consume
    expect(rl.tryAcquire("b")).toBe(false);
  });

  it("token-bucket refills proportionally to elapsed time", () => {
    const c = clock();
    const rl = new RateLimiter({ now: c.now }).register([{ bucket: "b", scope: "ip", algo: "token-bucket", capacity: 4, windowMs: 1000 }]);
    expect(rl.tryAcquire("b", 4)).toBe(true);
    expect(rl.available("b")).toBe(0);
    c.advance(500);                         // half the window → +2
    expect(rl.available("b")).toBe(2);
  });

  it("sliding-window caps hits within the trailing window", () => {
    const c = clock();
    const rl = new RateLimiter({ now: c.now }).register([{ bucket: "s", scope: "ip", algo: "sliding-window", capacity: 2, windowMs: 1000 }]);
    expect(rl.tryAcquire("s")).toBe(true);
    expect(rl.tryAcquire("s")).toBe(true);
    expect(rl.tryAcquire("s")).toBe(false);
    c.advance(1000);                        // oldest hits age out
    expect(rl.tryAcquire("s")).toBe(true);
  });

  it("burst: a grant needs BOTH the main and burst buckets", () => {
    const c = clock();
    const rl = new RateLimiter({ now: c.now }).register([
      { bucket: "p", scope: "ip", algo: "token-bucket", capacity: 100, windowMs: 60_000, burst: { capacity: 2, windowMs: 1000 } },
    ]);
    expect(rl.tryAcquire("p")).toBe(true);
    expect(rl.tryAcquire("p")).toBe(true);
    expect(rl.tryAcquire("p")).toBe(false); // burst exhausted though main has 98
    c.advance(1000);
    expect(rl.tryAcquire("p")).toBe(true);  // burst refilled
  });

  it("isolates capacity by scope key", () => {
    const c = clock();
    const rl = new RateLimiter({ now: c.now }).register([{ bucket: "w", scope: "wallet", algo: "token-bucket", capacity: 1, windowMs: 1000 }]);
    expect(rl.tryAcquire("w", 1, "wallet-A")).toBe(true);
    expect(rl.tryAcquire("w", 1, "wallet-A")).toBe(false);
    expect(rl.tryAcquire("w", 1, "wallet-B")).toBe(true); // separate key, separate bucket
  });

  it("acquire() waits via injected sleep until capacity frees", async () => {
    let t = 0;
    const rl = new RateLimiter({ now: () => t, sleep: async (ms) => { t += ms; } })
      .register([{ bucket: "b", scope: "ip", algo: "token-bucket", capacity: 1, windowMs: 1000 }]);
    await rl.acquire("b");       // consumes the single token (no wait)
    const before = t;
    await rl.acquire("b");       // must wait ~1 window for a refill
    expect(t).toBeGreaterThanOrEqual(before + 1000);
  });

  it("passes through unregistered buckets as unlimited", async () => {
    const rl = new RateLimiter();
    expect(rl.tryAcquire("unknown")).toBe(true);
    expect(rl.available("unknown")).toBe(Infinity);
    await rl.acquire("unknown"); // resolves immediately
  });

  it("acquire throws when weight exceeds the bucket capacity", async () => {
    const rl = new RateLimiter().register([{ bucket: "b", scope: "ip", algo: "token-bucket", capacity: 2, windowMs: 1000 }]);
    await expect(rl.acquire("b", 5)).rejects.toThrow(/exceeds/);
  });

  it("charge(): force-consume without a grant (may go below zero), waited off by later refills", () => {
    const c = clock();
    const rl = new RateLimiter({ now: c.now }).register([{ bucket: "b", scope: "ip", algo: "token-bucket", capacity: 10, windowMs: 1000 }]);
    rl.charge("b", 14);                       // spent 14 against a 10-token bucket → -4
    expect(rl.available("b")).toBeLessThan(0);
    expect(rl.tryAcquire("b")).toBe(false);   // the debt blocks grants
    c.advance(1000);                          // +10
    expect(rl.available("b")).toBe(6);        // -4 + 10
    rl.charge("unknown", 3);                  // unregistered bucket: no-op, no throw
    rl.charge("b", 0);                        // non-positive weight: no-op
    expect(rl.available("b")).toBe(6);
  });

  it("charge() on a sliding window counts the weight as hits", () => {
    const c = clock();
    const rl = new RateLimiter({ now: c.now }).register([{ bucket: "s", scope: "ip", algo: "sliding-window", capacity: 3, windowMs: 1000 }]);
    rl.charge("s", 2);
    expect(rl.available("s")).toBe(1);
    expect(rl.tryAcquire("s")).toBe(true);
    expect(rl.tryAcquire("s")).toBe(false);   // window full (2 charged + 1 acquired = 3)
  });
});
