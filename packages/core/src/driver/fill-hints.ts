// =============================================================================
// @farm/core · driver/fill-hints — routes a wallet-fill wake to the engine's nudge
// sink. A fill on a wallet's stream should wake the (campaign, pair) that wallet
// trades in so its counterpart follows at once (ExperimentConnector.fillHints), cutting
// the fill→follow latency that is half the headline capacity metric.
//
// Resolution is by SUBACCOUNT (owner), not by order digest: the owner is known from
// the per-wallet stream connection (or carried by the public `fill` stream), and the
// coordinator nudges by pairId and re-reads all facts — so a static subaccount→pair map
// (built once from the campaign's pairs) is all that's needed, with zero per-order
// registration churn. This mirrors the consumer's existing pattern.
// =============================================================================
import type { FillHintRef, FillHintRegistry, NudgeSink } from "./types.js";

export interface FillHintRouterOptions {
  /** A nudge failure is reported here (and swallowed) so a bad sink can't tear down
   *  the WS pump; the driver loop re-drives the pair as the backstop. Without this a
   *  persistently failing nudge silently degrades fill→wake to poll latency — skewing
   *  the benchmark — so Phase B should wire it for observability. */
  onNudgeError?: (error: unknown) => void;
}

export class FillHintRouter {
  constructor(
    private readonly registry: FillHintRegistry,
    private readonly sink: NudgeSink,
    private readonly opts: FillHintRouterOptions = {},
  ) {}

  /** A wallet (`subaccount`) filled — wake its pair. NEVER throws: both a synchronous
   *  throw and an async rejection from the sink are caught (the async IIFE turns a sync
   *  throw into a rejection), reported via onNudgeError, and swallowed. An unknown
   *  subaccount is ignored. */
  onFill(subaccount: string): void {
    if (!subaccount) return;
    const ref = this.registry.resolve(subaccount);
    if (!ref) return;
    void (async () => this.sink.nudge(ref.campaignId, ref.pairId))().catch((e) =>
      this.opts.onNudgeError?.(e),
    );
  }
}

/** A static subaccount → ref map the engine builds once from the campaign's pairs
 *  (and clears on stop). Subaccounts are case-folded (addresses are case-insensitive).
 *  `clear()` is the purge-on-stop the consumer's static map had. */
export class InMemoryFillHintRegistry implements FillHintRegistry {
  private readonly map = new Map<string, FillHintRef>();
  set(subaccount: string, ref: FillHintRef): void {
    this.map.set(subaccount.toLowerCase(), ref);
  }
  delete(subaccount: string): void {
    this.map.delete(subaccount.toLowerCase());
  }
  resolve(subaccount: string): FillHintRef | undefined {
    return this.map.get(subaccount.toLowerCase());
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
}
