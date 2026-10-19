import { describe, it, expect } from "vitest";
import { generateFleet } from "./mock.js";
import { filterWallets, accountOptions, cohortsOf } from "./filter.js";

describe("ui view-model (mock + filter)", () => {
  const fleet = generateFleet({ hdAccounts: 2, walletsPerHd: 5, pkAccounts: 2, seed: 1 });

  it("generateFleet is deterministic and correctly sized", () => {
    expect(fleet.wallets).toHaveLength(2 * 5 + 2); // 12
    expect(fleet.accounts).toHaveLength(4);
    expect(fleet.accounts.filter((a) => a.kind === "HD")).toHaveLength(2);
    expect(fleet.accounts.filter((a) => a.kind === "PK")).toHaveLength(2);
    const again = generateFleet({ hdAccounts: 2, walletsPerHd: 5, pkAccounts: 2, seed: 1 });
    expect(again.wallets[0]!.address.value).toBe(fleet.wallets[0]!.address.value);
  });

  it("filters wallets by account (HD + PK)", () => {
    const allIds = fleet.accounts.map((a) => a.id);
    expect(filterWallets(fleet.wallets, allIds)).toHaveLength(12);
    expect(filterWallets(fleet.wallets, ["hd-0"])).toHaveLength(5);
    expect(filterWallets(fleet.wallets, ["pk-0"])).toHaveLength(1);
    expect(filterWallets(fleet.wallets, [])).toHaveLength(0); // nothing checked → nothing shown
  });

  it("intersects the account filter with cohort tags", () => {
    const allIds = fleet.accounts.map((a) => a.id);
    const cohort = cohortsOf(fleet.wallets)[0]!;
    const out = filterWallets(fleet.wallets, allIds, [cohort]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((w) => w.cohorts.includes(cohort))).toBe(true);
  });

  it("accountOptions mirrors the accounts (id/kind/count)", () => {
    const opts = accountOptions(fleet.accounts);
    expect(opts.map((o) => o.id)).toEqual(fleet.accounts.map((a) => a.id));
    expect(opts.find((o) => o.id === "hd-0")?.count).toBe(5);
  });
});
