import { describe, it, expect } from "vitest";
import { validateOrder } from "./validate.js";
import type { Market, PlaceOrderInput, Decimal, Bps } from "@farm/adapter-api";

const d = (s: string) => s as Decimal;
const market: Market = {
  id: "nado:perp:BTC-PERP", chainId: 57073, product: "perp", base: "BTC", quote: "USDT0",
  tickSize: d("0.1"), stepSize: d("0.001"), minNotional: d("10"),
  makerFeeBps: 0 as Bps, takerFeeBps: 0 as Bps, raw: null,
};
const order = (over: Partial<PlaceOrderInput> = {}): PlaceOrderInput => ({
  market: market.id, side: "buy", kind: "limit", size: d("0.1"), price: d("63120"), clientId: "c", ...over,
});

describe("validateOrder (M10)", () => {
  it("rounds price to tick (nearest) and size to step (down)", () => {
    const v = validateOrder(order({ price: d("63120.07"), size: d("0.1005") }), market);
    expect(v.normalized.price).toBe("63120.1");
    expect(v.normalized.size).toBe("0.1");
    expect(v.violations.map((x) => x.code).sort()).toEqual(["STEP_ROUNDED", "TICK_ROUNDED"]);
    expect(v.ok).toBe(true);
  });

  it("passes a clean on-tick order with no violations", () => {
    const v = validateOrder(order(), market);
    expect(v.violations).toHaveLength(0);
    expect(v.ok).toBe(true);
  });

  it("errors when the size rounds down to zero", () => {
    const v = validateOrder(order({ size: d("0.0001") }), market); // < step 0.001 → 0
    expect(v.ok).toBe(false);
    expect(v.violations.some((x) => x.code === "NON_POSITIVE_SIZE")).toBe(true);
  });

  it("errors below min-notional", () => {
    const m2: Market = { ...market, stepSize: d("0.0001"), minNotional: d("100") };
    const v = validateOrder(order({ size: d("0.001") }), m2); // notional 63.12 < 100
    expect(v.ok).toBe(false);
    expect(v.violations.some((x) => x.code === "MIN_NOTIONAL")).toBe(true);
  });

  it("skips tick/notional checks for market orders", () => {
    const v = validateOrder(order({ kind: "market", price: undefined }), market);
    expect(v.violations.filter((x) => x.code === "TICK_ROUNDED" || x.code === "MIN_NOTIONAL")).toHaveLength(0);
    expect(v.ok).toBe(true);
  });
});
