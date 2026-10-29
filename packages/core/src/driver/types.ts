// =============================================================================
// @farm/core · driver/types — the protocol-agnostic SEAMS that wire the capacity
// engine together. Phase 0 defines the interfaces + the glue (FillHintRouter,
// DriverLoop, ClockSource); Phase A's experiment coordinator IMPLEMENTS TickDriver +
// NudgeSink and populates the FillHintRegistry as it dispatches resting makers. No
// live order flow here — these are the sockets the A/B loop plugs into.
// =============================================================================

/** A monotonic, clock-corrected time source — a `() => number`, matching the
 *  coordinator's `ExperimentCoordinatorOptions.now`. The Nado order nonce encodes a
 *  recv time, so a skewed operator clock gets orders rejected — the engine mints
 *  order nonces/expirations and runs its FSM timers off THIS clock, fed from ClockSync
 *  (see clock.ts). Defaults to the system clock when no sync is wired. */
export type ClockSource = () => number;

/** The engine's per-tick driver — Phase A's ExperimentCoordinator implements this.
 *  `tick(id?)` advances the A/B round FSM one step for all campaigns (or one). */
export interface TickDriver {
  tick(id?: string): Promise<unknown>;
}

/** A fill-hint sink — Phase A's coordinator.nudge. A proven fill for a resting maker
 *  wakes its pair AT ONCE instead of waiting for the next poll (ExperimentConnector
 *  .fillHints). */
export interface NudgeSink {
  nudge(campaignId: string, pairId: string): Promise<void> | void;
}

/** Which (campaign, pair) a wallet belongs to. */
export interface FillHintRef {
  campaignId: string;
  pairId: string;
}

/** Resolves a wallet SUBACCOUNT (owner) to the (campaign, pair) it trades in — a
 *  STATIC map built once from the campaign's pairs (one wallet ↔ one pair), mirroring
 *  the consumer's existing nudge-from-static-map pattern (apps/console/.../experimentWake
 *  + ExperimentCoordinator.nudge). No per-order churn: a fill on a wallet's stream
 *  wakes that wallet's pair, and the coordinator re-reads the facts (the hint is a pure
 *  wake signal — a late/wrong hint only costs a read). An unknown subaccount → undefined
 *  (ignored). */
export interface FillHintRegistry {
  resolve(subaccount: string): FillHintRef | undefined;
}
