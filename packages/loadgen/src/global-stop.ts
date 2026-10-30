// =============================================================================
// @farm/loadgen · global-stop — the GLOBAL net-loss stop (the real-funds "$25" hard backstop,
// M0 guardrail §3.3 / abort §5). A reusable per-tick guard: it reads the cohort's total USDT0
// collateral, measures the drop from a funded baseline, and when the drop reaches the configured
// stop it fires ONCE. At N=1 the pair is hedged (net ≈ 0), so the drop is realized cost (fees +
// any spread paid), marked to market.
//
// It does NOT halt the coordinator or stop the ledger itself: `coordinator.halt()` would freeze
// the engine so the wind-down could not run, and `ledger.stop()` refuses EVERY submit — including
// the reduce-only CLOSES the flatten needs. So the trip instead drives the §5 abort sequence
// (requestExit -> close open rounds reduce-only -> assertCohortFlatSettled), which the caller
// wires through `onStop`; new opens are already blocked by EXITING, and the ledger is simply
// never re-enabled afterwards (it stays disabled by not opening anything new). Pure over injected
// seams (cohort-equity read + clock), unit-tested offline with no network and no funds.
// =============================================================================
import type { EquitySource } from "./experiment-connector.js";

export interface GlobalStopInfo {
  /** The funded baseline equity (x18): supplied, or captured on the first check. */
  baselineX18: bigint;
  /** The cohort's current total USDT0 collateral (x18). */
  currentX18: bigint;
  /** baseline - current (x18). Positive = a loss; negative = a gain. */
  dropX18: bigint;
  /** The configured stop (x18 loss), or undefined when the guard is OFF. */
  stopX18: bigint | undefined;
  /** A stop threshold is configured and positive. */
  armed: boolean;
  /** This check is the moment the drop first reached the stop (fires `onStop` exactly once). */
  tripped: boolean;
}

export interface GlobalNetLossStopDeps {
  /** Total cohort equity now (x18): sum of every cohort wallet's USDT0 collateral. */
  cohortEquityX18: () => Promise<bigint>;
  /** The configured stop (x18 loss). Undefined or <= 0 → the guard is OFF (the generous default:
   *  the drop is still measured + logged, but it never trips). */
  stopX18?: bigint;
  /** The funded baseline (x18). Omitted → captured on the FIRST check (the funded starting point). */
  baselineX18?: bigint;
  /** Fired at most ONCE, when the drop first reaches the stop. The caller drives the §5 abort
   *  here (set the run-terminating signal / requestExit); see the module header for why it must
   *  not halt the coordinator or stop the ledger before the flatten. */
  onStop: (info: GlobalStopInfo) => void | Promise<void>;
  /** Per-check diagnostic hook (optional) — called on every check, tripped or not. */
  onCheck?: (info: GlobalStopInfo) => void;
  /** Minimum ms between equity reads. A check inside this window returns the last info without
   *  re-reading (bounds getBalances load at sub-slot tick rates). Default 0 = read every call. */
  minIntervalMs?: number;
  /** Clock for the throttle. Default Date.now. Injected in tests. */
  now?: () => number;
}

export class GlobalNetLossStop {
  private baseline?: bigint;
  private fired = false;
  private lastAt = -Infinity;
  private last?: GlobalStopInfo;
  private readonly now: () => number;
  constructor(private readonly deps: GlobalNetLossStopDeps) {
    if (deps.baselineX18 !== undefined) this.baseline = deps.baselineX18;
    this.now = deps.now ?? Date.now;
  }
  /** Whether the stop has already fired (one-way latch). */
  get stopped(): boolean { return this.fired; }
  /** The captured funded baseline (undefined until the first check). */
  get baselineX18(): bigint | undefined { return this.baseline; }

  /**
   * Read the cohort equity, measure the drop, and fire `onStop` once if the drop reaches the stop.
   * Throttled by `minIntervalMs`: inside the window it returns the last info without re-reading
   * (and never fires again once latched). An equity read failure propagates — an unreadable
   * account is never silently treated as "no loss" (the per-wallet maxLoss path blocks new risk
   * on the same unknown).
   */
  async check(): Promise<GlobalStopInfo> {
    const minInterval = this.deps.minIntervalMs ?? 0;
    if (this.last && (this.fired || this.now() - this.lastAt < minInterval)) return this.last;
    const current = await this.deps.cohortEquityX18();
    this.lastAt = this.now();
    if (this.baseline === undefined) this.baseline = current; // first read = funded baseline
    const stopX18 = this.deps.stopX18;
    const armed = stopX18 !== undefined && stopX18 > 0n;
    const dropX18 = this.baseline - current;
    const tripped = armed && !this.fired && dropX18 >= stopX18!;
    const info: GlobalStopInfo = { baselineX18: this.baseline, currentX18: current, dropX18, stopX18, armed, tripped };
    this.last = info;
    this.deps.onCheck?.(info);
    if (tripped) { this.fired = true; await this.deps.onStop(info); }
    return info;
  }
}

/**
 * A cohort-equity reader: sum the per-wallet live equity source across the cohort's owners. An
 * unobservable wallet equity (a `null` from the source) throws — the global stop never computes a
 * drop from a partial/unknown cohort equity (unknown is never "no loss").
 */
export function cohortEquityReader(owners: readonly string[], equityFor: EquitySource): () => Promise<bigint> {
  return async (): Promise<bigint> => {
    let sum = 0n;
    for (const owner of owners) {
      const e = await equityFor(owner);
      if (e === null) throw new Error(`GLOBAL_STOP_EQUITY_UNKNOWN:${owner}`);
      sum += BigInt(e);
    }
    return sum;
  };
}
