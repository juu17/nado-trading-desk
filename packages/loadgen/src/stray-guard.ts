// =============================================================================
// @farm/loadgen · stray-guard — the stray-fill CIRCUIT-BREAKER (real-funds M0 guardrail §3.4).
//
// A "stray" is a round whose self-cross did NOT fire cleanly as an A↔B match: A's maker was hit
// by a stranger, or B swept external liquidity before reaching A — so a one-sided real position
// was opened. On this branch the coordinator ALREADY flattens such a round reduce-only and
// continues (earlyExitReason → A_CLOSE withdraws A's maker + closes A reduce-only → B_CLOSE closes
// B reduce-only → VERIFYING_FLAT → next round); cancel-on-timeout (build 4) bounds A's exposure
// that leads into it. This module does NOT re-issue that flatten (doing so from the runner would
// race/double-close the coordinator's own close). It also does NOT touch UNKNOWN rounds — a
// genuine maybe-placed UNKNOWN still aborts via the runner's checkTerminating (UNKNOWN=abort wins).
//
// What is net-new here is the cohort-level BREAKER: count the flattened strays and their realized
// cost, and TRIP (→ the same terminate → requestExit → assertCohortFlatSettled abort that the
// global net-loss stop uses, §5) once strays get too frequent (count cap) OR too expensive
// (cumulative cost > half the global stop). Pure over its inputs (round evidence read offline from
// the campaign) + injected caps/clock — unit-tested with hand-built rounds, no network, no funds.
// =============================================================================
import type { ExperimentRound } from "@farm/core";

export type StrayKind = "external-sweep" | "maker-hit" | "partial-cross";

export interface StrayInfo {
  roundId: string;
  kind: StrayKind;
  /** Realized cost of the flattened stray (x18, ≥ 0): the round's net loss (fees + spread). */
  costX18: bigint;
}

export interface StrayBreakerInfo {
  /** Strays counted so far. */
  strayCount: number;
  /** Cumulative realized cost of the counted strays (x18). */
  cumulativeCostX18: bigint;
  stopCount: number | undefined;
  stopCostX18: bigint | undefined;
  /** This scan crossed a cap for the first time (fires onTrip exactly once). */
  tripped: boolean;
  /** Why it tripped: "count" or "cost" (set only on the tripping scan). */
  reason?: "count" | "cost";
}

export interface StrayGuardDeps {
  /** Trip when the stray count EXCEEDS this. Undefined → the count cap is OFF. */
  stopCount?: number;
  /** Trip when cumulative stray cost EXCEEDS this (x18; the design's "half the global stop").
   *  Undefined → the cost cap is OFF. */
  stopCostX18?: bigint;
  /** Per newly-counted stray (diagnostic). */
  onStray?: (s: StrayInfo, b: StrayBreakerInfo) => void;
  /** Fired at most ONCE, when a cap is first exceeded. The caller drives the §5 abort here
   *  (set the run-terminating signal) — same as the global net-loss stop; it must NOT flatten
   *  (the coordinator already does). */
  onTrip: (b: StrayBreakerInfo) => void | Promise<void>;
}

const X18 = (s: string | undefined): bigint => { try { return BigInt(s ?? "0"); } catch { return 0n; } };

/** A round's net realized cost as a non-negative x18 loss (fees + spread). A clean or stray round
 *  that flattened nets to a small loss; a gain (rare) counts as zero cost. Absent result → 0. */
export function roundCostX18(round: ExperimentRound): bigint {
  const r = round.result;
  if (!r) return 0n;
  const pnl = X18(r.aPnlX18) + X18(r.bPnlX18);
  return pnl < 0n ? -pnl : 0n;
}

/**
 * Classify a SETTLED round (state COMPLETED) as a stray, or undefined if it is a clean self-cross
 * or an empty skip. Classification is on POSITIVE fill evidence only — the open legs' fills:
 *   - clean A↔B cross: A_OPEN filled == B_OPEN filled (both > 0) → not a stray
 *   - empty skip (e.g. REPRICE_EXHAUSTED_EXIT / no empty tick): both 0 → not a stray (no exposure)
 *   - external-sweep: B_OPEN filled > 0, A_OPEN filled 0 (B swept external, A never crossed)
 *   - maker-hit:     A_OPEN filled > 0, B_OPEN filled 0 (A hit by a stranger, B never crossed)
 *   - partial-cross: both filled but unequal (a one-sided remainder was flattened)
 * A round that is NOT yet COMPLETED is never counted (it may still be mid-cross); UNKNOWN rounds
 * are handled by the abort gate, not here, so they are never reclassified as a stray.
 */
export function classifyStray(round: ExperimentRound): StrayInfo | undefined {
  if (round.state !== "COMPLETED") return undefined;
  const fillOf = (role: string) => round.orders
    .filter((o) => o.role === role && o.state === "TERMINAL")
    .reduce((n, o) => n + X18(o.filledX18), 0n);
  const a = fillOf("A_OPEN"), b = fillOf("B_OPEN");
  if (a === b) return undefined;                    // clean cross (a==b>0) or empty skip (0==0)
  const kind: StrayKind = a === 0n ? "external-sweep" : b === 0n ? "maker-hit" : "partial-cross";
  return { roundId: round.id, kind, costX18: roundCostX18(round) };
}

export class StrayGuard {
  private readonly seen = new Set<string>();
  private count = 0;
  private cost = 0n;
  private fired = false;
  constructor(private readonly deps: StrayGuardDeps) {}

  get strayCount(): number { return this.count; }
  get cumulativeCostX18(): bigint { return this.cost; }
  get tripped(): boolean { return this.fired; }

  private info(tripped: boolean, reason?: "count" | "cost"): StrayBreakerInfo {
    return { strayCount: this.count, cumulativeCostX18: this.cost, stopCount: this.deps.stopCount, stopCostX18: this.deps.stopCostX18, tripped, reason };
  }

  /**
   * Scan the campaign's rounds; count any NEWLY-settled stray (once, by round id) and its cost,
   * and TRIP the breaker (fire onTrip once) the first time a cap is exceeded. Idempotent across
   * repeated scans of the same rounds. Returns the latest breaker state.
   */
  async scan(rounds: readonly ExperimentRound[]): Promise<StrayBreakerInfo> {
    for (const round of rounds) {
      if (this.seen.has(round.id)) continue;
      const stray = classifyStray(round);
      if (round.state !== "COMPLETED") continue; // only settled rounds are final; leave unsettled for a later scan
      this.seen.add(round.id);                   // a settled round is classified once and for all
      if (!stray) continue;
      this.count++; this.cost += stray.costX18;
      this.deps.onStray?.(stray, this.info(false));
    }
    if (!this.fired) {
      const overCount = this.deps.stopCount !== undefined && this.count > this.deps.stopCount;
      const overCost = this.deps.stopCostX18 !== undefined && this.cost > this.deps.stopCostX18;
      if (overCount || overCost) {
        this.fired = true;
        const b = this.info(true, overCount ? "count" : "cost");
        await this.deps.onTrip(b);
        return b;
      }
    }
    return this.info(false);
  }
}

export interface AbortGraceDeps {
  /** How long a transient UNKNOWN may persist (continuously) before the run aborts on it. */
  graceMs: number;
  /** Clock. Default Date.now; injected in tests. */
  now?: () => number;
}

/**
 * The bounded "let the coordinator resolve it" grace for a TRANSIENT UNKNOWN. The three
 * dispatch/lookup/cancel `*_UNKNOWN` codes are transient (recovery.ts): the coordinator retries
 * them and the winding/EXITING path re-polls them every tick, so a run that hit a stray and is
 * self-healing should NOT be aborted on the first UNKNOWN tick (the testnet ASTER false-abort).
 * This grants a bounded window of continuous UNKNOWN presence for that self-heal; past it, the run
 * aborts (preserving UNKNOWN=abort — the abort path's requestExit + drain then re-polls and
 * closes/cancels the order). A FATAL/REJECT is NOT given grace (abort at once); nor is a breaker
 * trip. A cleared UNKNOWN resets the window (the coordinator resolved it → the run continues).
 */
export class AbortGrace {
  private since?: number;
  private readonly now: () => number;
  constructor(private readonly deps: AbortGraceDeps) { this.now = deps.now ?? Date.now; }
  /** Observe this tick's transient-UNKNOWN reason (undefined = none pending). Returns the reason
   *  to ABORT on only once an UNKNOWN has been present continuously for ≥ graceMs. */
  observe(reason: string | undefined): string | undefined {
    if (!reason) { this.since = undefined; return undefined; }
    if (this.since === undefined) this.since = this.now();
    return this.now() - this.since >= this.deps.graceMs ? reason : undefined;
  }
  /** Whether an UNKNOWN is currently within its grace window (pending, not yet aborting). */
  get pending(): boolean { return this.since !== undefined; }
}
