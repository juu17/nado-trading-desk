// @farm/loadgen — the Nado capacity-benchmark composition layer: it wires @farm/core's
// protocol-agnostic engine (the experiment A/B coordinator + the OrderLedger no-double-place
// kernel) to @farm/adapter-nado's Nado sequencer primitives. Kept out of @farm/core (Ink
// stays behind the adapter) and out of @farm/adapter-nado (which stays core-free); this is
// the seam where both meet.
//
// Phase A lands the two highest-leverage, protocol-shape-independent correctness cores here
// first (unit-tested offline, "mock connector first"): deterministic/idempotent order
// identity (no-double-place) and dispatch-outcome classification (halt vs drop-one). The
// full ExperimentConnector assembly (gateway relay + per-order fill lookup) is wired and
// validated at the testnet gate, where the live Nado read API + WAF behaviour are confirmed.
export * from "./order-identity.js";
export * from "./classify.js";
export * from "./live-order-fill.js";
export * from "./live-connector.js";
export * from "./cohort-settle.js";
export * from "./self-trade.js";
export * from "./metrics.js";
export * from "./ramp.js";
