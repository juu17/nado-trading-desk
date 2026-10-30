// =============================================================================
// @farm/core · read-budget — the SHARED single-IP read budget "28" (Phase B-1, decision #6).
//
// Every wallet and every lane in the capacity harness reads through ONE egress IP, so the
// Nado sequencer meters them against ONE per-IP bucket. This is the GOVERNING ceiling of the
// benchmark: hitting it is the accepted boundary of "capacity reachable from one egress", not
// a failed run. The policy here is the operator-calibrated budget the intern ran 20-pair loads
// at (nadoBudget MAX_RATE=28 / URGENT_RESERVE=8; relayQueryBudget RATE=28 / WINDOW_WEIGHT=400).
//
// It is a POLICY over the BASE `RateLimiter`, NOT a second limiter: the RateLimiter owns all
// token accounting (one bucket, one group — no per-wallet key, so every caller shares it). The
// policy adds only what a plain bucket lacks:
//   • an URGENT reserve — a hedging pair (one side filled, the other not) or a cancel/kill read
//     jumps ahead of routine reconcile reads, which leave `URGENT_RESERVE` weight free for it;
//   • charge() — weight the relay spent on its own retries (x-relay-attempts), charged after
//     the fact so later reads on the one budget wait it off;
//   • a 429 backoff — after the exchange throttles the IP, routine reads hold off for a bounded
//     cooldown (urgent reads still go as the bucket refills), so the client settles AT the
//     ceiling instead of overshooting into a 429-storm (which, unlike the ceiling, invalidates
//     a run — see docs/phasea-testnet-validation.md §6).
//
// The clock + sleep are injected (shared with the RateLimiter's), so every behaviour is unit-
// tested deterministically with no real timers.
//
// [consumption seam] B-1 DEFINES and tests the budget policy. The read-dispatch path (the
// cohort-settle gate's reads, the connector's reconcile/cancel reads) is routed THROUGH this one
// instance where the harness is composed (the B-4 driver / the live connector at the testnet
// gate), tagging a pair's fill-critical follow/cancel reads `urgent` so a 429 cooldown never
// freezes a pending fill. Until then only tests acquire through it.
// =============================================================================
import { RateLimiter, type RateLimiterDeps } from "./limiter.js";

/** The one shared per-IP read bucket all wallets/lanes draw from. */
export const READ_BUDGET_BUCKET = "nado:read";
/** Sustained weight/sec the budget refills at (operator-chosen 2026-10-26 for 20-pair runs;
 *  70% of Nado's published 40/s engine-query allowance, leaving headroom for under-counted
 *  weights and other programs on the same IP). */
export const READ_BUDGET_MAX_RATE = 28;
/** Max standing burst (tokens) — a quiet window lets a short spike of reads fire at once. */
export const READ_BUDGET_BURST = 48;
/** Weight routine reads always leave free for urgent (hedging / cancel) reads. */
export const READ_BUDGET_URGENT_RESERVE = 8;
/** Nado's published hard per-IP engine-query cap (documented; non-binding under 28/s + 48
 *  burst — the most weight spendable in any 10 s is 48 + 28·10 = 328 < 400). */
export const READ_BUDGET_WINDOW_WEIGHT = 400;
export const READ_BUDGET_WINDOW_MS = 10_000;
/** After the exchange throttles the IP (429), routine reads hold off this long. */
export const READ_BUDGET_THROTTLE_COOLDOWN_MS = 30_000;

export interface ReadAcquire {
  /** Read weight (defaults to 1). */
  weight?: number;
  /** A hedging/cancel read: uses the whole budget (the reserve is for it) and ignores the
   *  post-429 cooldown that holds routine reads. */
  urgent?: boolean;
  signal?: AbortSignal;
}

// token-bucket windowMs that refills exactly MAX_RATE tokens/sec at capacity BURST:
//   refill/sec = capacity / windowMs · 1000 = BURST / (BURST·1000/MAX_RATE) · 1000 = MAX_RATE.
const BUDGET_WINDOW_MS = (READ_BUDGET_BURST * 1000) / READ_BUDGET_MAX_RATE;

/**
 * The shared single-IP read budget. Construct one per harness run and give every wallet/lane
 * the SAME instance — that is what makes it the single-IP ceiling. Pass a `limiter` to layer
 * the read bucket onto the run's existing RateLimiter (so order buckets and reads share one
 * authority); otherwise it creates its own. The bucket has no scope key, so all callers share
 * the one group regardless of wallet.
 */
export class SharedReadBudget {
  private readonly limiter: RateLimiter;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Routine reads hold off until this time after a throttle (429). */
  private routineHoldUntil = 0;

  constructor(deps: RateLimiterDeps = {}, limiter?: RateLimiter) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.limiter = (limiter ?? new RateLimiter(deps)).register([
      { bucket: READ_BUDGET_BUCKET, scope: "ip", algo: "token-bucket", capacity: READ_BUDGET_BURST, windowMs: BUDGET_WINDOW_MS },
    ]);
  }

  /** The underlying RateLimiter (shared authority), for wiring order buckets onto the same one.
   *  Consumers MUST acquire the read bucket only through this policy (or with NO key) — passing a
   *  per-wallet key to `READ_BUDGET_BUCKET` would split it into per-wallet groups and multiply the
   *  single-IP budget N×, defeating decision #6. The read bucket is shared by having no key. */
  get rateLimiter(): RateLimiter { return this.limiter; }

  /** Spare weight a read of this class may take right now (floored at 0). Routine callers see
   *  the budget minus the urgent reserve; urgent callers see the whole budget. */
  available(urgent = false): number {
    const raw = this.limiter.available(READ_BUDGET_BUCKET);
    return Math.max(0, raw - (urgent ? 0 : READ_BUDGET_URGENT_RESERVE));
  }

  /** Non-blocking: take `weight` now or return false (no wait). A routine read refuses rather
   *  than dip into the urgent reserve or break a post-429 cooldown. */
  tryAcquire({ weight = 1, urgent = false }: ReadAcquire = {}): boolean {
    this.validate(weight);
    if (!urgent && this.now() < this.routineHoldUntil) return false;
    const reserve = urgent ? 0 : READ_BUDGET_URGENT_RESERVE;
    if (this.limiter.available(READ_BUDGET_BUCKET) - reserve < weight) return false;
    return this.limiter.tryAcquire(READ_BUDGET_BUCKET, weight);
  }

  /** Blocking: wait (via the injected sleep) until `weight` is available under this read's class,
   *  then consume it. Urgent reads use the whole budget; routine reads leave the reserve and, for
   *  a bounded cooldown after a 429, hold off entirely so urgent reads drain first. */
  async acquire({ weight = 1, urgent = false, signal }: ReadAcquire = {}): Promise<void> {
    this.validate(weight);
    const reserve = urgent ? 0 : READ_BUDGET_URGENT_RESERVE;
    // A read this class can never satisfy (its usable budget is BURST minus the reserve it must
    // leave) would otherwise spin forever waiting for capacity that never arrives — fail loud,
    // as the BASE RateLimiter.acquire does for weight > capacity.
    if (weight + reserve > READ_BUDGET_BURST)
      throw new Error(`read weight ${weight} exceeds the ${urgent ? "urgent" : "routine"} budget capacity ${READ_BUDGET_BURST - reserve}`);
    for (;;) {
      if (signal?.aborted) throw new Error("rate acquire aborted");
      const now = this.now();
      const cooling = !urgent && now < this.routineHoldUntil;
      const avail = this.limiter.available(READ_BUDGET_BUCKET);
      if (!cooling && avail - reserve >= weight && this.limiter.tryAcquire(READ_BUDGET_BUCKET, weight)) return;
      // During the cooldown the gate is TIME (wait it out in one sleep); otherwise it is TOKENS
      // (back off proportional to the deficit, capped so a wake-up can overtake a routine read).
      const refillMs = Math.ceil((Math.max(weight + reserve - avail, 0.5) / READ_BUDGET_MAX_RATE) * 1000);
      const wait = cooling ? this.routineHoldUntil - now : Math.max(urgent ? 10 : 25, Math.min(urgent ? 100 : 500, refillMs));
      await this.sleep(Math.max(1, wait));
    }
  }

  /** Weight the relay spent on its OWN retries (x-relay-attempts), charged after the fact so
   *  later ROUTINE reads pace down. FLOORED AT ZERO: it drains only the spare budget, never into
   *  debt, so a relay retry — the read already succeeded — never delays a fill-critical URGENT
   *  read (which would wait off the whole debt). The charge slows routine reads only; a real 429
   *  is the separate, heavier `onThrottled()` back-off. Best-effort: a non-finite/≤0 weight is a
   *  no-op and it never throws (accounting must not break trading). */
  charge(weight: number): void {
    if (!Number.isFinite(weight) || weight <= 0) return;
    const spare = Math.max(0, this.limiter.available(READ_BUDGET_BUCKET));
    if (spare > 0) this.limiter.charge(READ_BUDGET_BUCKET, Math.min(weight, spare));
  }

  /** The relay saw the exchange throttle this IP (429): drain the spare budget and hold routine
   *  reads off for a bounded cooldown. Urgent reads still proceed as the bucket refills.
   *  [testnet seam] Nothing offline triggers a 429, so the cooldown branch in acquire() is inert
   *  in the offline deliverable; it activates at the testnet phase when the relay reports a 429. */
  onThrottled(): void {
    const spare = this.limiter.available(READ_BUDGET_BUCKET);
    if (spare > 0) this.limiter.charge(READ_BUDGET_BUCKET, spare);
    this.routineHoldUntil = this.now() + READ_BUDGET_THROTTLE_COOLDOWN_MS;
  }

  private validate(weight: number): void {
    if (!Number.isFinite(weight) || weight <= 0) throw new Error("READ_WEIGHT_INVALID");
  }
}
