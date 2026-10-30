// @farm/core · experiment — the A/B maker↔taker round FSM (the capacity engine's core
// loop) and its helpers, ported from lucklab (coordinator/types/validation/route from 1.5;
// the rest from 1.4.3). The funding⇄experiment circular edges are cut, the deferred
// rollover/hub/compaction/set-aside branches stay inert under the single-group, no-route,
// max-throughput benchmark config, and the desk document is threaded as
// DeskOperations<ExperimentCampaign>. Network lives behind the ExperimentConnector seam.
export * from "./types.js";
export * from "./coordinator.js";
export * from "./guards.js";
export * from "./validation.js";
export * from "./route.js";
export * from "./sizing.js";
export * from "./recovery.js";
export * from "./cost.js";
export * from "./timing.js";
export * from "./markets.js";
export * from "./pairRolling.js";
export * from "./rehearsalPreset.js";
