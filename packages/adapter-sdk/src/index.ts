// @farm/adapter-sdk — optional helpers for adapter authors: the conformance suite
// (the over-abstraction detector). Core does NOT depend on this; adapters run it as
// a property test in CI so they can't drift from the universal seam contract.
export { runConformance } from "./conformance.js";
export type { ConformanceInput, ConformanceResult, ConformanceCheck, Eip712Case } from "./conformance.js";
