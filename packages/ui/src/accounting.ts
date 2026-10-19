// =============================================================================
// @farm/ui · accounting (Q61) — fleet-wide activity rollup + CSV/JSON export.
// Pure: aggregates activity records into per-wallet and per-cohort totals (a
// record counts toward every cohort it carries). No strategy/PnL opinions —
// counts, volume, and fees over what actually ran.
// =============================================================================
export interface AccountingRecord {
  walletId: string;
  accountName?: string;
  cohorts?: readonly string[];
  market: string;
  side: "buy" | "sell";
  notional: number; // price × size
  fee: number;
  status: string;
  ts: number;
}

export interface Rollup {
  key: string;
  orders: number;
  volume: number;
  buys: number;
  sells: number;
  fees: number;
}
export type Totals = Omit<Rollup, "key">;

export interface AccountingReport {
  totals: Totals;
  byWallet: Rollup[];
  byCohort: Rollup[];
}

function emptyAgg(): Totals { return { orders: 0, volume: 0, buys: 0, sells: 0, fees: 0 }; }
function add(agg: Totals, r: AccountingRecord): void {
  agg.orders += 1;
  agg.volume += r.notional;
  agg.fees += r.fee;
  if (r.side === "buy") agg.buys += 1; else agg.sells += 1;
}

export function rollup(records: readonly AccountingRecord[]): AccountingReport {
  const totals = emptyAgg();
  const wallet = new Map<string, Totals>();
  const cohort = new Map<string, Totals>();
  for (const r of records) {
    add(totals, r);
    const w = wallet.get(r.walletId) ?? emptyAgg();
    add(w, r);
    wallet.set(r.walletId, w);
    for (const c of r.cohorts ?? []) {
      const cg = cohort.get(c) ?? emptyAgg();
      add(cg, r);
      cohort.set(c, cg);
    }
  }
  const toRows = (m: Map<string, Totals>): Rollup[] =>
    [...m].map(([key, a]) => ({ key, ...a })).sort((x, y) => y.volume - x.volume);
  return { totals, byWallet: toRows(wallet), byCohort: toRows(cohort) };
}

/** Per-wallet rollup as CSV. */
export function toCsv(report: AccountingReport): string {
  const head = "wallet,orders,volume,buys,sells,fees";
  const rows = report.byWallet.map((r) => `${r.key},${r.orders},${r.volume.toFixed(2)},${r.buys},${r.sells},${r.fees.toFixed(4)}`);
  return [head, ...rows].join("\n");
}

export function toJson(report: AccountingReport): string {
  return JSON.stringify(report, null, 2);
}
