import { describe, it, expect } from "vitest";
import { nadoMarketSizing, clampOrderSize } from "./sizing.js";

// Raw values captured LIVE from api.test.nado.xyz getSymbols (2026-10-18):
//   BTC-PERP : minSize 100e18, sizeIncrement 5e13,   priceIncrement "1"
//   wAAPLx   : minSize 100e18, sizeIncrement 1e15,   priceIncrement "0.01"
const BTC = () => nadoMarketSizing("1", 50_000_000_000_000n, 100_000_000_000_000_000_000n);
const AAPL = () => nadoMarketSizing("0.01", 1_000_000_000_000_000n, 100_000_000_000_000_000_000n);

describe("nadoMarketSizing — getSymbols unit interpretation", () => {
  it("reads BTC-PERP: the 'minSize' field is a USDT0 notional (100), base step is 0.00005", () => {
    const s = BTC();
    expect(s.tickSize).toBe("1");
    expect(s.stepSize).toBe("0.00005");
    expect(s.minSize).toBe("0.00005");   // base min = one increment, NOT 100
    expect(s.minNotional).toBe("100");   // the misnamed field = 100 USDT0 notional
  });

  it("min notional is UNIFORM across assets while the base step differs — proving it is a notional, not a size", () => {
    const btc = BTC(), aapl = AAPL();
    expect(btc.minNotional).toBe("100");
    expect(aapl.minNotional).toBe("100"); // identical → cannot be a per-asset base size
    expect(btc.stepSize).not.toBe(aapl.stepSize);
  });
});

describe("clampOrderSize", () => {
  const btc = () => { const s = BTC(); return { stepSize: s.stepSize, minSize: s.minSize, minNotional: s.minNotional }; };

  it("does NOT inflate a normal size — the bug: 0.01 must stay 0.01, never jump to 100", () => {
    expect(clampOrderSize("0.01", { ...btc(), price: 81250 })).toBe("0.01");
  });

  it("the resulting notional of a normal order is the TRUE notional (price × size), well under a sane cap", () => {
    const size = clampOrderSize("0.01", { ...btc(), price: 81250 });
    expect(Number(size) * 81250).toBeCloseTo(812.5, 4); // ~812 USDT0, not 8,125,000
  });

  it("bumps a sub-min-notional size UP to clear the venue minimum, but stays small (not inflated)", () => {
    const size = clampOrderSize("0.0001", { ...btc(), price: 81250 }); // 0.0001 × 81250 = 8.1 < 100
    expect(Number(size) * 81250).toBeGreaterThanOrEqual(100);
    expect(Number(size)).toBeLessThan(0.01); // ~0.00125, nowhere near 100
  });

  it("a zero/blank size floors to one step then meets the min notional", () => {
    const size = clampOrderSize("0", { ...btc(), price: 81250 });
    expect(Number(size) * 81250).toBeGreaterThanOrEqual(100);
  });

  it("back-compat: with no price/minNotional (offline mock path) it just floors + aligns to step", () => {
    expect(clampOrderSize("0.1", { stepSize: "0.001", minSize: "0.001" })).toBe("0.1");
    expect(clampOrderSize("0.0001", { stepSize: "0.001", minSize: "0.001" })).toBe("0.001"); // floors to min, no notional bump
  });
});
