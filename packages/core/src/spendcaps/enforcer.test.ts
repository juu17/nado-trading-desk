import { describe, it, expect } from "vitest";
import { SpendCapEnforcer } from "./enforcer.js";
import type { Usd } from "@farm/adapter-api";

const usd = (n: number) => n as Usd;
const req = (over: Partial<Parameters<SpendCapEnforcer["charge"]>[0]> = {}) => ({
  walletId: "w1", usd: 0, blastRadius: "trading" as const, ...over,
});

describe("SpendCapEnforcer", () => {
  it("allows everything when disabled", () => {
    const e = new SpendCapEnforcer({ enabled: false, perOpUsd: usd(1) });
    expect(e.charge(req({ usd: 1_000_000 })).allowed).toBe(true);
  });

  it("enforces the per-op cap", () => {
    const e = new SpendCapEnforcer({ enabled: true, perOpUsd: usd(100) });
    expect(e.charge(req({ usd: 100 })).allowed).toBe(true);
    const d = e.charge(req({ usd: 101 }));
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("PER_OP_CAP");
  });

  it("enforces the blast-radius ceiling", () => {
    const e = new SpendCapEnforcer({ enabled: true, maxBlastRadius: "trading" });
    expect(e.charge(req({ blastRadius: "trading" })).allowed).toBe(true);
    expect(e.charge(req({ blastRadius: "funds-move" })).code).toBe("BLAST_RADIUS_CAP");
  });

  it("enforces the per-wallet window cap and isolates wallets", () => {
    let t = 0;
    const e = new SpendCapEnforcer({ enabled: true, perWalletWindowUsd: usd(100), windowMs: 1000 }, () => t);
    expect(e.charge(req({ walletId: "A", usd: 60 })).allowed).toBe(true);
    expect(e.charge(req({ walletId: "A", usd: 40 })).allowed).toBe(true);
    expect(e.charge(req({ walletId: "A", usd: 1 })).code).toBe("PER_WALLET_CAP"); // 101 > 100
    expect(e.charge(req({ walletId: "B", usd: 90 })).allowed).toBe(true);         // separate wallet
    t = 1001; // window elapsed → A's spend ages out
    expect(e.charge(req({ walletId: "A", usd: 90 })).allowed).toBe(true);
  });

  it("enforces per-cohort and global caps", () => {
    const e = new SpendCapEnforcer({ enabled: true, perCohortUsd: usd(150), windowMs: 10_000 }, () => 0);
    expect(e.charge(req({ walletId: "A", cohortId: "x", usd: 100 })).allowed).toBe(true);
    expect(e.charge(req({ walletId: "B", cohortId: "x", usd: 60 })).code).toBe("PER_COHORT_CAP"); // 160 > 150
    const e2 = new SpendCapEnforcer({ enabled: true, globalPerWindowUsd: usd(150), windowMs: 10_000 }, () => 0);
    expect(e2.charge(req({ walletId: "A", usd: 100 })).allowed).toBe(true);
    expect(e2.charge(req({ walletId: "B", usd: 60 })).code).toBe("GLOBAL_CAP");
  });

  it("does not charge a rejected op (atomic check-then-record)", () => {
    const e = new SpendCapEnforcer({ enabled: true, perWalletWindowUsd: usd(100), windowMs: 10_000 }, () => 0);
    expect(e.charge(req({ walletId: "A", usd: 90 })).allowed).toBe(true);
    expect(e.charge(req({ walletId: "A", usd: 20 })).allowed).toBe(false); // would be 110 → rejected, NOT recorded
    expect(e.charge(req({ walletId: "A", usd: 10 })).allowed).toBe(true);  // 90 + 10 = 100 OK (the 20 was not charged)
  });
});
