// @farm/ui — protocol-agnostic console view-model + logic (pure; no React/Kumo).
// The React shell (frozen sidebar · horizontal card wall · right drawer) composes
// these in apps/console. Imports @farm/adapter-api only; NEVER a concrete adapter.
export type { AccountVM, WalletVM, Fleet, AccountKind, WalletStatus, Readiness } from "./model.js";
export { generateFleet } from "./mock.js";
export type { FleetOptions } from "./mock.js";
export { filterWallets, accountOptions, cohortsOf } from "./filter.js";
export type { AccountOption } from "./filter.js";
export { renderActionForm } from "./form.js";
export { rollup, toCsv, toJson } from "./accounting.js";
export type { AccountingRecord, AccountingReport, Rollup, Totals } from "./accounting.js";
export { computeReadiness } from "./readiness.js";
export type { ReadinessInputs } from "./readiness.js";
