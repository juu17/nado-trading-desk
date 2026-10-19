import { describe, it, expect } from "vitest";
import { rollup, toCsv } from "./accounting.js";
import type { AccountingRecord } from "./accounting.js";

const rec = (over: Partial<AccountingRecord> = {}): AccountingRecord => ({
  walletId: "hd-0:0", market: "nado:perp:BTC-PERP", side: "buy", notional: 100, fee: 0.1, status: "open", ts: 0, ...over,
});

describe("accounting rollup (Q61)", () => {
  const records: AccountingRecord[] = [
    rec({ walletId: "A", cohorts: ["alpha"], side: "buy", notional: 100, fee: 0.1 }),
    rec({ walletId: "A", cohorts: ["alpha", "maker"], side: "sell", notional: 200, fee: 0.2 }),
    rec({ walletId: "B", cohorts: ["maker"], side: "buy", notional: 50, fee: 0.05 }),
  ];

  it("aggregates totals, per-wallet, and per-cohort (a record counts in each cohort)", () => {
    const r = rollup(records);
    expect(r.totals).toMatchObject({ orders: 3, volume: 350, buys: 2, sells: 1 });
    expect(r.totals.fees).toBeCloseTo(0.35);

    const a = r.byWallet.find((w) => w.key === "A")!;
    expect(a).toMatchObject({ orders: 2, volume: 300, buys: 1, sells: 1 });

    const maker = r.byCohort.find((c) => c.key === "maker")!;
    expect(maker.orders).toBe(2); // A's sell + B's buy
    expect(maker.volume).toBe(250);
    expect(r.byWallet[0]!.key).toBe("A"); // sorted by volume desc
  });

  it("exports per-wallet CSV with a header", () => {
    const csv = toCsv(rollup(records));
    const lines = csv.split("\n");
    expect(lines[0]).toBe("wallet,orders,volume,buys,sells,fees");
    expect(lines[1]).toBe("A,2,300.00,1,1,0.3000");
    expect(lines).toHaveLength(3); // header + 2 wallets
  });
});
