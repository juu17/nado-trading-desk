// =============================================================================
// @farm/core · drift/theft reconciliation (M11) — diff the EXPECTED fleet state
// (our local records) against the ACTUAL state (chain/gateway) and flag
// discrepancies. A shortfall beyond a threshold is a possible theft/loss →
// critical alert. Scaffold: amounts are plain numbers (the composition root
// supplies expected/actual snapshots); a live version keys off on-chain reads.
// =============================================================================
import type { WalletId } from "@farm/adapter-api";
import type { Alerter } from "../alerting/alerting.js";

export interface BalanceSnapshot { walletId: WalletId; asset: string; amount: number }

export interface ReconcileOptions {
  toleranceAbs?: number;      // ignore drift within this absolute amount (dust)
  toleranceBps?: number;      // ignore drift within this relative bps of expected
  theftThresholdAbs?: number; // a shortfall at/above this is critical (possible theft)
}

export type DiscrepancyKind = "missing-funds" | "unexpected-funds";
export type DiscrepancySeverity = "info" | "warning" | "critical";

export interface Discrepancy {
  walletId: WalletId;
  asset: string;
  expected: number;
  actual: number;
  delta: number; // actual − expected
  kind: DiscrepancyKind;
  severity: DiscrepancySeverity;
}

export interface ReconcileReport {
  checkedKeys: number;
  discrepancies: Discrepancy[];
  ok: boolean; // true when nothing worse than info
}

const keyOf = (s: { walletId: WalletId; asset: string }): string => `${s.walletId}\u0000${s.asset}`;

export function reconcile(
  expected: readonly BalanceSnapshot[],
  actual: readonly BalanceSnapshot[],
  opts: ReconcileOptions = {},
): ReconcileReport {
  const tolAbs = opts.toleranceAbs ?? 0;
  const tolBps = opts.toleranceBps ?? 0;
  const theft = opts.theftThresholdAbs ?? Infinity;

  const exp = new Map<string, BalanceSnapshot>();
  for (const s of expected) exp.set(keyOf(s), s);
  const act = new Map<string, BalanceSnapshot>();
  for (const s of actual) act.set(keyOf(s), s);

  const keys = new Set([...exp.keys(), ...act.keys()]);
  const discrepancies: Discrepancy[] = [];

  for (const k of keys) {
    const e = exp.get(k);
    const a = act.get(k);
    const ref = (e ?? a) as BalanceSnapshot;
    const expectedAmt = e?.amount ?? 0;
    const actualAmt = a?.amount ?? 0;
    const delta = actualAmt - expectedAmt;
    const tol = Math.max(tolAbs, (tolBps / 10_000) * Math.abs(expectedAmt));
    if (Math.abs(delta) <= tol) continue;

    const kind: DiscrepancyKind = delta < 0 ? "missing-funds" : "unexpected-funds";
    const severity: DiscrepancySeverity =
      kind === "missing-funds" ? (Math.abs(delta) >= theft ? "critical" : "warning") : "info";
    discrepancies.push({ walletId: ref.walletId, asset: ref.asset, expected: expectedAmt, actual: actualAmt, delta, kind, severity });
  }

  return { checkedKeys: keys.size, discrepancies, ok: discrepancies.every((d) => d.severity === "info") };
}

/** Reconcile and raise an alert for each warning/critical discrepancy. */
export function reconcileAndAlert(
  expected: readonly BalanceSnapshot[],
  actual: readonly BalanceSnapshot[],
  alerter: Alerter,
  opts: ReconcileOptions = {},
): ReconcileReport {
  const report = reconcile(expected, actual, opts);
  for (const d of report.discrepancies) {
    if (d.severity === "info") continue;
    alerter.raise({
      severity: d.severity,
      code: `RECON_${d.kind.toUpperCase()}:${d.walletId}:${d.asset}`,
      title: `${d.kind} on ${d.walletId} / ${d.asset}`,
      detail: `expected ${d.expected}, actual ${d.actual} (Δ ${d.delta})`,
      context: { walletId: d.walletId, asset: d.asset, delta: d.delta },
    });
  }
  return report;
}
