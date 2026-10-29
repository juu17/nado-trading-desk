// =============================================================================
// @farm/core · driver/clock — feed the engine's ClockSource from ClockSync. The
// composition root syncs ClockSync from the sequencer's server time, then injects
// this source into the order-building path (nonce/expiration) and the coordinator's
// FSM timers, so a skewed operator clock does not get orders rejected (the recv-time
// nonce window). ClockSync already exposes a corrected now(); this adapts it to the
// ClockSource seam. Without a sync, `systemClock` is the uncorrected fallback.
// =============================================================================
import { ClockSync } from "../clocksync/index.js";
import type { ClockSource } from "./types.js";

export function clockSourceFromSync(sync: ClockSync): ClockSource {
  return () => sync.now();
}

export const systemClock: ClockSource = () => Date.now();
