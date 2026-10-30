// Offline gate for the LIVE per-wallet equity source (real-funds M0 guardrail). A FAKE gateway
// stands in for the live getBalances read; no network, no funds. Proves the USDT0 collateral is
// summed into an x18 equity string, that a non-USDT0 balance is ignored, that a read failure
// propagates (unknown is never flat), and the decimal→x18 conversion.
import { describe, expect, it } from "vitest";
import type { Balance } from "@farm/adapter-api";
import type { NadoGateway } from "@farm/adapter-nado";
import { createLiveEquitySource, decimalToX18, USDT0_PRODUCT_ID } from "./live-equity.js";

const bal = (asset: string, total: string): Balance =>
  ({ asset, symbol: asset, total: total as Balance["total"], available: total as Balance["available"], scope: "margin", raw: null });

const gatewayWith = (balances: Balance[] | (() => Promise<Balance[]>)) =>
  ((_o: string) => ({ getBalances: async () => (typeof balances === "function" ? balances() : balances) })) as unknown as
    (owner: string) => Pick<NadoGateway, "getBalances">;

describe("decimalToX18", () => {
  it("parses integers, fractions, zero and negatives to x18", () => {
    expect(decimalToX18("0")).toBe(0n);
    expect(decimalToX18("1")).toBe(10n ** 18n);
    expect(decimalToX18("100.5")).toBe(100n * 10n ** 18n + 5n * 10n ** 17n);
    expect(decimalToX18("-12.25")).toBe(-(12n * 10n ** 18n + 25n * 10n ** 16n));
    expect(decimalToX18("0.000000000000000001")).toBe(1n); // 1e-18
  });
  it("truncates sub-1e-18 dust rather than rounding", () => {
    expect(decimalToX18("0.0000000000000000019")).toBe(1n);
  });
  it("throws on an unparseable amount (never a silent zero)", () => {
    for (const bad of ["", "-", ".", "abc", "1.2.3", "0x5"]) expect(() => decimalToX18(bad)).toThrow();
  });
});

describe("createLiveEquitySource", () => {
  it("sums the wallet's USDT0 (product 0) collateral into an x18 equity string", async () => {
    const src = createLiveEquitySource(gatewayWith([bal(String(USDT0_PRODUCT_ID), "123.5")]));
    expect(await src("0xabc")).toBe((123n * 10n ** 18n + 5n * 10n ** 17n).toString());
  });

  it("ignores non-USDT0 balances (e.g. a perp product position value)", async () => {
    const src = createLiveEquitySource(gatewayWith([bal("0", "100"), bal("2", "999"), bal("3", "7")]));
    expect(await src("0xabc")).toBe((100n * 10n ** 18n).toString());
  });

  it("sums multiple USDT0 rows if the venue returns them split", async () => {
    const src = createLiveEquitySource(gatewayWith([bal("0", "60"), bal("0", "40.5")]));
    expect(await src("0xabc")).toBe((100n * 10n ** 18n + 5n * 10n ** 17n).toString());
  });

  it("returns '0' for a wallet with no USDT0 collateral (a real zero, not null)", async () => {
    const src = createLiveEquitySource(gatewayWith([bal("2", "5")]));
    expect(await src("0xabc")).toBe("0");
  });

  it("honours a custom subaccount + collateral product id", async () => {
    let seenSub = "";
    const forOwner = ((_o: string) => ({ getBalances: async (sub: string) => { seenSub = sub; return [bal("7", "42")]; } })) as unknown as
      (owner: string) => Pick<NadoGateway, "getBalances">;
    const src = createLiveEquitySource(forOwner, { subaccount: "iso", collateralProductId: 7 });
    expect(await src("0xabc")).toBe((42n * 10n ** 18n).toString());
    expect(seenSub).toBe("iso");
  });

  it("propagates a read failure (the coordinator treats an unreadable account as unknown, never flat)", async () => {
    const src = createLiveEquitySource(gatewayWith(async () => { throw new Error("network"); }));
    await expect(src("0xabc")).rejects.toThrow("network");
  });
});
