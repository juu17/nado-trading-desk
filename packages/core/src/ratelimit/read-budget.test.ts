import { describe, it, expect } from "vitest";
import { RateLimiter } from "./limiter.js";
import {
  SharedReadBudget,
  READ_BUDGET_BUCKET, READ_BUDGET_BURST, READ_BUDGET_MAX_RATE, READ_BUDGET_URGENT_RESERVE,
  READ_BUDGET_THROTTLE_COOLDOWN_MS, READ_BUDGET_WINDOW_MS, READ_BUDGET_WINDOW_WEIGHT,
} from "./read-budget.js";

/** A manual clock whose `sleep` advances `now` (so blocking waits are deterministic). */
function driver() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, at: () => t };
}

describe("SharedReadBudget", () => {
  it("starts at the burst capacity; routine sees it minus the urgent reserve", () => {
    const d = driver();
    const b = new SharedReadBudget({ now: d.now, sleep: d.sleep });
    expect(b.available(true)).toBe(READ_BUDGET_BURST);                       // 48
    expect(b.available(false)).toBe(READ_BUDGET_BURST - READ_BUDGET_URGENT_RESERVE); // 40
  });

  it("is ONE shared budget: every lane/wallet draws the same tokens, and routine stops at the reserve", () => {
    const d = driver();
    const b = new SharedReadBudget({ now: d.now, sleep: d.sleep });
    // 40 routine reads from assorted "lanes" (no key — all share the one group) drain to the reserve.
    for (let i = 0; i < READ_BUDGET_BURST - READ_BUDGET_URGENT_RESERVE; i++) expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);          // routine refused: the reserve is protected
    expect(b.available(false)).toBe(0);
    expect(b.available(true)).toBe(READ_BUDGET_URGENT_RESERVE); // 8 left for urgent
    // Urgent reads dip into the reserve down to empty.
    for (let i = 0; i < READ_BUDGET_URGENT_RESERVE; i++) expect(b.tryAcquire({ urgent: true })).toBe(true);
    expect(b.tryAcquire({ urgent: true })).toBe(false);
    expect(b.available(true)).toBe(0);
  });

  it("refills toward the burst cap over time (token-bucket under the policy)", () => {
    const d = driver();
    const b = new SharedReadBudget({ now: d.now, sleep: d.sleep });
    for (let i = 0; i < READ_BUDGET_BURST; i++) expect(b.tryAcquire({ urgent: true })).toBe(true); // drain
    expect(b.available(true)).toBe(0);
    d.sleep(READ_BUDGET_BURST / READ_BUDGET_MAX_RATE * 1000 + 100); // past a full refill
    expect(b.available(true)).toBe(READ_BUDGET_BURST);  // capped at the burst
  });

  it("blocking acquire() waits for a refill when the budget is empty", async () => {
    const d = driver();
    const b = new SharedReadBudget({ now: d.now, sleep: d.sleep });
    for (let i = 0; i < READ_BUDGET_BURST; i++) expect(b.tryAcquire({ urgent: true })).toBe(true);
    const t0 = d.at();
    await b.acquire({ urgent: true });                 // must wait ~1 token (1/28 s)
    expect(d.at()).toBeGreaterThan(t0);
  });

  it("urgent reads jump the reserve: an urgent read passes immediately where a routine read must wait", async () => {
    const d = driver();
    const b = new SharedReadBudget({ now: d.now, sleep: d.sleep });
    for (let i = 0; i < READ_BUDGET_BURST - READ_BUDGET_URGENT_RESERVE; i++) b.tryAcquire(); // drain to the reserve
    expect(b.available(false)).toBe(0);
    const tu = d.at();
    await b.acquire({ urgent: true });                 // reserve is for it → no wait
    expect(d.at()).toBe(tu);
    const tr = d.at();
    await b.acquire();                                 // routine must wait for a refill above the reserve
    expect(d.at()).toBeGreaterThan(tr);
  });

  it("charge() drains spare only (floored at 0): it paces routine reads but never stalls an urgent read", async () => {
    const d = driver();
    const b = new SharedReadBudget({ now: d.now, sleep: d.sleep });
    b.charge(READ_BUDGET_BURST - READ_BUDGET_URGENT_RESERVE); // 40 of 48 → 8 left (the reserve)
    expect(b.available(false)).toBe(0);
    expect(b.available(true)).toBe(READ_BUDGET_URGENT_RESERVE);
    b.charge(1000);                                    // a huge retry charge: drains spare to 0, NEVER into debt
    expect(b.available(true)).toBe(0);
    // A fill-critical urgent read waits at most ~1 token (≈36 ms), NOT the whole charge debt
    // (the intern's reviewed "charge slows routine reads only" — regressing it taxes the fill path).
    const tu = d.at();
    await b.acquire({ urgent: true });
    expect(d.at() - tu).toBeLessThan(100);
    // A routine read still paces behind the reserve.
    const tr = d.at();
    await b.acquire();
    expect(d.at()).toBeGreaterThan(tr);
  });

  it("throws on a weight the budget can never satisfy (no unbounded wait)", async () => {
    const b = new SharedReadBudget();
    await expect(b.acquire({ weight: READ_BUDGET_BURST + 1, urgent: true })).rejects.toThrow(/exceeds/);
    await expect(b.acquire({ weight: READ_BUDGET_BURST - READ_BUDGET_URGENT_RESERVE + 1 })).rejects.toThrow(/exceeds/); // routine: > 40
    await expect(b.acquire({ weight: READ_BUDGET_BURST - READ_BUDGET_URGENT_RESERVE })).resolves.toBeUndefined();        // routine: exactly 40 fits
  });

  it("the published 400/10s hard cap can never bind under 28/s + 48 burst (documented invariant)", () => {
    // The sliding window is deliberately NOT registered (one bucket). Guard the arithmetic that
    // justifies it, so a future bump to BURST/MAX_RATE that would breach 400 fails loudly here.
    const maxSpendPer10s = READ_BUDGET_BURST + READ_BUDGET_MAX_RATE * (READ_BUDGET_WINDOW_MS / 1000);
    expect(maxSpendPer10s).toBeLessThanOrEqual(READ_BUDGET_WINDOW_WEIGHT); // 48 + 280 = 328 ≤ 400
  });

  it("onThrottled() drains the budget and holds routine reads for the cooldown; urgent reads still pass", async () => {
    const d = driver();
    const b = new SharedReadBudget({ now: d.now, sleep: d.sleep });
    b.onThrottled();
    expect(b.available(true)).toBe(0);                 // drained
    expect(b.tryAcquire()).toBe(false);                // routine refused during the cooldown
    const tu = d.at();
    await b.acquire({ urgent: true });                 // urgent ignores the cooldown, waits only for a refill
    expect(d.at()).toBeGreaterThan(tu);
    expect(d.at()).toBeLessThan(READ_BUDGET_THROTTLE_COOLDOWN_MS);
    await b.acquire();                                 // routine waits out the remaining cooldown
    expect(d.at()).toBeGreaterThanOrEqual(READ_BUDGET_THROTTLE_COOLDOWN_MS);
  });

  it("layers onto an injected RateLimiter so order buckets and reads share one authority", () => {
    const d = driver();
    const shared = new RateLimiter({ now: d.now, sleep: d.sleep });
    const b = new SharedReadBudget({ now: d.now, sleep: d.sleep }, shared);
    expect(b.rateLimiter).toBe(shared);
    b.tryAcquire();                                    // drains the read bucket on the shared limiter
    expect(shared.available(READ_BUDGET_BUCKET)).toBe(READ_BUDGET_BURST - 1);
  });

  it("rejects a non-positive or non-finite weight", async () => {
    const b = new SharedReadBudget();
    expect(() => b.tryAcquire({ weight: 0 })).toThrow(/READ_WEIGHT_INVALID/);
    expect(() => b.tryAcquire({ weight: Number.NaN })).toThrow(/READ_WEIGHT_INVALID/);
    await expect(b.acquire({ weight: -1 })).rejects.toThrow(/READ_WEIGHT_INVALID/);
  });

  it("aborts a blocking acquire via the signal", async () => {
    const d = driver();
    const b = new SharedReadBudget({ now: d.now, sleep: d.sleep });
    for (let i = 0; i < READ_BUDGET_BURST; i++) b.tryAcquire({ urgent: true }); // drain
    const ac = new AbortController();
    ac.abort();
    await expect(b.acquire({ urgent: true, signal: ac.signal })).rejects.toThrow(/aborted/);
  });
});
