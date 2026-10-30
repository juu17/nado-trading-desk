// Offline gate for the self-cross market picker (real-funds M0/M1 §7). Fake top-of-book reads,
// no network. Proves: a clean stable crypto perp is chosen; an FX mirage (huge %-of-mid spread) is
// rejected; an equity perp (w…x) is excluded; a too-tight (< floor) market is skipped; stability
// requires EVERY sample to clear the floor; testnet mode (no filters, single sample) is unchanged.
import { describe, expect, it, vi } from "vitest";
import { pickMarket, isCryptoPerp, isEquityPerp, isFxPerp, baseSymbol, type MarketCandidate, type TopOfBook } from "./market-picker.js";

const noSleep = async () => {};
/** A reader backed by a per-product scripted sequence of top-of-book readings (loops the last). */
function reader(books: Record<number, (TopOfBook | null)[]>) {
  const idx: Record<number, number> = {};
  return async (pid: number): Promise<TopOfBook | null> => {
    const seq = books[pid] ?? [null];
    const i = Math.min(idx[pid] ?? 0, seq.length - 1);
    idx[pid] = (idx[pid] ?? 0) + 1;
    return seq[i]!;
  };
}
const flat = (bid: number, ask: number) => ({ bidPx: bid, askPx: ask });

describe("symbol classification", () => {
  it("isEquityPerp matches wrapped-equity tickers (w…x), with or without -PERP", () => {
    for (const s of ["wTSLAx", "wQQQx-PERP", "wSPYx", "wMETAx", "wGOOGLx-PERP", "wAAPLx"]) expect(isEquityPerp(s)).toBe(true);
    for (const s of ["WETH-PERP", "KBTC-PERP", "BTC-PERP", "WIFX-PERP"]) expect(isEquityPerp(s)).toBe(false); // not w…x base
  });
  it("isFxPerp matches fiat↔fiat pairs", () => {
    for (const s of ["GBPUSD-PERP", "USDJPY-PERP", "EURUSD", "AUDUSD-PERP"]) expect(isFxPerp(s)).toBe(true);
    for (const s of ["WETH-PERP", "DOGE-PERP", "BTCUSD-PERP"]) expect(isFxPerp(s)).toBe(false); // BTC is not a fiat code
  });
  it("isCryptoPerp is the complement (24/7 crypto)", () => {
    for (const s of ["WETH-PERP", "KBTC-PERP", "DOGE-PERP", "JUP-PERP", "FARTCOIN-PERP"]) expect(isCryptoPerp(s)).toBe(true);
    for (const s of ["wTSLAx", "GBPUSD-PERP"]) expect(isCryptoPerp(s)).toBe(false);
  });
  it("baseSymbol strips a quote/perp suffix", () => {
    expect(baseSymbol("WETH-PERP")).toBe("WETH");
    expect(baseSymbol("GBPUSD-PERP")).toBe("GBPUSD");
  });
});

const cands: MarketCandidate[] = [
  { productId: 1, symbol: "WETH-PERP", tick: 0.1 },     // crypto, genuine
  { productId: 2, symbol: "KBTC-PERP", tick: 1 },       // crypto, genuine (wider ticks)
  { productId: 3, symbol: "GBPUSD-PERP", tick: 0.0001 },// FX mirage
  { productId: 4, symbol: "wTSLAx-PERP", tick: 0.01 },  // equity
  { productId: 5, symbol: "DOGE-PERP", tick: 0.00001 }, // crypto, too tight
];

describe("pickMarket — mainnet mode (crypto-only + stable + anti-mirage)", () => {
  const cfg = { spreadFloorTicks: 3, samples: 3, sampleGapMs: 1, excludeNonCrypto: true, maxSpreadFracOfMid: 0.02 };

  it("chooses a clean stable crypto perp, rejecting the FX mirage, equity perp, and too-tight market", async () => {
    const readTopOfBook = reader({
      1: [flat(2500.0, 2500.5)],   // WETH: spread 5 ticks (0.5/0.1), 0.02% of mid — genuine
      2: [flat(60000, 60004)],     // KBTC: spread 4 ticks (4/1), 0.007% of mid — genuine, lower min-spread
      3: [flat(1.0, 1.14)],        // GBPUSD: spread 14% of mid — MIRAGE
      4: [flat(100, 100.5)],       // wTSLAx: would qualify on spread but is an equity perp
      5: [flat(0.1, 0.100001)],    // DOGE: spread 1 tick < floor 3 — too tight
    });
    const onReject = vi.fn();
    const picked = await pickMarket({ candidates: cands, readTopOfBook, sleep: noSleep, onReject }, cfg);
    expect(picked?.symbol).toBe("WETH-PERP");           // highest stable min-spread among the genuine crypto perps
    expect(picked?.productId).toBe(1);
    expect(picked?.minSpreadTicks).toBe(5);
    const reasons = Object.fromEntries(onReject.mock.calls.map((c) => [c[0], c[2]]));
    expect(reasons["wTSLAx-PERP"]).toMatch(/equity/);
    expect(reasons["GBPUSD-PERP"]).toMatch(/fx-perp/);  // excluded by symbol before the read
    expect(reasons["DOGE-PERP"]).toMatch(/< floor/);
  });

  it("rejects a mirage caught at READ time (an FX-named-crypto-looking book that is a %-of-mid blowout)", async () => {
    // A lone non-FX-named candidate whose book is a mirage (huge %-of-mid) is still rejected.
    const readTopOfBook = reader({ 9: [flat(1.0, 1.2)] }); // 20 ticks but 18% of mid
    const onReject = vi.fn();
    const picked = await pickMarket({ candidates: [{ productId: 9, symbol: "MIRAGE-PERP", tick: 0.01 }], readTopOfBook, sleep: noSleep, onReject }, cfg);
    expect(picked).toBeNull();
    expect(onReject.mock.calls[0]?.[2]).toMatch(/mirage/);
  });

  it("requires EVERY sample to clear the floor (a spread that DIPS below floor disqualifies)", async () => {
    const readTopOfBook = reader({
      1: [flat(2500, 2500.5), flat(2500, 2500.1), flat(2500, 2500.5)], // dips to 1 tick on sample 2
      2: [flat(60000, 60004), flat(60000, 60005), flat(60000, 60004)], // stays >= 4t
    });
    const picked = await pickMarket({ candidates: [cands[0]!, cands[1]!], readTopOfBook, sleep: noSleep }, cfg);
    expect(picked?.symbol).toBe("KBTC-PERP"); // WETH disqualified by the dip; KBTC stable
  });

  it("returns null when no candidate has a stable workable spread", async () => {
    const readTopOfBook = reader({ 1: [flat(2500, 2500.1)], 2: [flat(60000, 60001)] }); // both 1 tick < floor 3
    expect(await pickMarket({ candidates: [cands[0]!, cands[1]!], readTopOfBook, sleep: noSleep }, cfg)).toBeNull();
  });
});

describe("pickMarket — testnet mode (unchanged: no filters, single sample, widest ≥ floor)", () => {
  const cfg = { spreadFloorTicks: 3, samples: 1 }; // excludeNonCrypto off, no mirage check

  it("picks the widest market ≥ floor from the candidate pids, as before", async () => {
    const readTopOfBook = reader({
      22: [flat(100, 100.3)],  // 3 ticks (tick 0.1)
      48: [flat(50, 50.6)],    // 6 ticks — widest
      52: [flat(10, 10.1)],    // 1 tick < floor
    });
    const c: MarketCandidate[] = [
      { productId: 22, symbol: "JUP-PERP", tick: 0.1 },
      { productId: 48, symbol: "ASTER-PERP", tick: 0.1 },
      { productId: 52, symbol: "DOGE-PERP", tick: 0.1 },
    ];
    const picked = await pickMarket({ candidates: c, readTopOfBook, sleep: noSleep }, cfg);
    expect(picked?.productId).toBe(48);
    expect(picked?.minSpreadTicks).toBe(6);
  });

  it("does NOT apply crypto/mirage filters in testnet mode (an FX-named candidate could still win)", async () => {
    // Guards that testnet behaviour is unchanged: no excludeNonCrypto, no mirage check.
    const readTopOfBook = reader({ 7: [flat(100, 100.5)] }); // 5 ticks, 0.5% of mid
    const picked = await pickMarket({ candidates: [{ productId: 7, symbol: "GBPUSD-PERP", tick: 0.1 }], readTopOfBook, sleep: noSleep }, cfg);
    expect(picked?.productId).toBe(7); // not filtered out in testnet mode
  });
});
