// =============================================================================
// @farm/loadgen · market-picker — choose the self-cross benchmark market (real-funds M0/M1).
//
// The M1 mainnet dry-run (docs/re/mainnet-run-safety-design.md §7) showed that ranking by the
// WIDEST raw spread is wrong on mainnet: the widest "spreads" are near-empty FX perps (GBPUSD's
// book is ~14% of mid — a liquidity MIRAGE) and halt-prone equity perps (wTSLAx/wQQQx/…). The
// correct target is a LIQUID CRYPTO PERP with a genuine, STABLE spread (WETH ~59t, KBTC ~57t —
// real two-sided depth, 24/7, empty between the touches so improve-the-touch + B-hard-limited-to-A
// lands A↔B cleanly). This module is that chooser: pure over an injected top-of-book read + sleep
// (the live getMarketLiquidity is handed in by the gated runner), unit-tested with fakes — no
// network, no funds, no orders. Testnet keeps its loose behaviour (no filters, single sample);
// mainnet turns the filters on.
// =============================================================================

/** Fiat currency codes — an FX perp is a pair of two of these (e.g. GBPUSD, USDJPY, EURUSD). */
const FIAT_CODES = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD",
  "CNH", "CNY", "HKD", "SGD", "MXN", "SEK", "NOK", "TRY", "ZAR", "KRW", "INR", "BRL",
]);

/** The symbol without its perp marker, case PRESERVED (so the lowercase-w…x equity pattern can be
 *  told apart from an all-caps crypto ticker). */
function stripPerp(symbol: string): string {
  return String(symbol).replace(/[-_/](PERP|SWAP)$/i, "");
}

/** The base symbol without the perp marker, upper-cased (for the FX fiat-pair check). */
export function baseSymbol(symbol: string): string {
  return stripPerp(symbol).toUpperCase();
}

/** An equity perp: a wrapped-equity ticker like wTSLAx / wQQQx / wSPYx — lowercase `w` + an
 *  uppercase stock ticker + lowercase `x`. Case-SENSITIVE so an all-caps crypto (WETH, WIFX) is
 *  NOT caught. These halt off-hours, so they are unusable for a 24/7 self-cross. */
export function isEquityPerp(symbol: string): boolean {
  return /^w[A-Z0-9]+x$/.test(stripPerp(symbol));
}

/** An FX perp: a fiat↔fiat pair (6 letters = two fiat codes). Near-empty on this venue (a mirage
 *  book), and not the liquid-crypto target. */
export function isFxPerp(symbol: string): boolean {
  const b = baseSymbol(symbol);
  return b.length === 6 && FIAT_CODES.has(b.slice(0, 3)) && FIAT_CODES.has(b.slice(3, 6));
}

/** A 24/7 crypto perp (what we want): neither an equity nor an FX perp. */
export function isCryptoPerp(symbol: string): boolean {
  return !isEquityPerp(symbol) && !isFxPerp(symbol);
}

export interface MarketCandidate {
  productId: number;
  symbol: string;
  /** Human price tick (priceIncrement). Must be > 0 to be considered. */
  tick: number;
}

/** A top-of-book reading for a product (human prices). null = no live two-sided book. */
export interface TopOfBook { bidPx: number; askPx: number }

export interface MarketPickerConfig {
  /** A workable market's spread must be ≥ this many ticks on EVERY sample (= maker headroom + 1). */
  spreadFloorTicks: number;
  /** Reads per candidate (the spread must stay ≥ the floor across all of them). Default 1. */
  samples?: number;
  /** Delay between sample rounds (ms) — a stable spread must survive this long. Default 0. */
  sampleGapMs?: number;
  /** Mainnet: drop equity + FX perps, keeping only 24/7 crypto perps. Default false (testnet). */
  excludeNonCrypto?: boolean;
  /** Mainnet: reject a MIRAGE — a spread wider than this fraction of mid signals a near-empty /
   *  placeholder book (GBPUSD ≈ 0.14). Undefined = no mirage check (testnet). */
  maxSpreadFracOfMid?: number;
}

export interface MarketPickerDeps {
  /** All tradable markets to consider (mainnet: ALL perps from getSymbols; testnet: the pid list). */
  candidates: readonly MarketCandidate[];
  /** Read a product's top of book (live getMarketLiquidity depth 1, faked in tests). */
  readTopOfBook: (productId: number) => Promise<TopOfBook | null>;
  /** Sleep between sample rounds. Default a real setTimeout; injected (instant) in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-candidate rejection reason (diagnostic). */
  onReject?: (symbol: string, productId: number, reason: string) => void;
}

export interface PickedMarket {
  productId: number;
  symbol: string;
  tick: number;
  /** The minimum spread (ticks) observed across the samples (the stable floor it cleared). */
  minSpreadTicks: number;
  /** Every sampled spread (ticks), for the run record. */
  spreadsTicks: number[];
}

/**
 * Pick the best workable market in ONE sampled pass, or null if none qualifies (the caller may
 * retry — the book may open a window later). A candidate qualifies iff, on EVERY sample, it has a
 * live two-sided book with a spread ≥ spreadFloorTicks AND (when maxSpreadFracOfMid is set) a
 * spread that is NOT a mirage (≤ that fraction of mid); and (when excludeNonCrypto is set) it is a
 * 24/7 crypto perp. Among the qualifiers the one with the highest MIN spread is chosen (the most
 * reliably-above-floor genuine book — WETH/KBTC-class), ties broken by productId for determinism.
 */
export async function pickMarket(deps: MarketPickerDeps, cfg: MarketPickerConfig): Promise<PickedMarket | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const samples = Math.max(1, Math.floor(cfg.samples ?? 1));
  const reject = (c: MarketCandidate, reason: string) => deps.onReject?.(c.symbol, c.productId, reason);

  let pool = deps.candidates.filter((c) => c.tick > 0);
  if (cfg.excludeNonCrypto) {
    pool = pool.filter((c) => {
      if (isEquityPerp(c.symbol)) { reject(c, "equity-perp (halts off-hours)"); return false; }
      if (isFxPerp(c.symbol)) { reject(c, "fx-perp (mirage book)"); return false; }
      return true;
    });
  }

  const qualified: PickedMarket[] = [];
  for (const c of pool) {
    const spreads: number[] = [];
    let ok = true;
    for (let i = 0; i < samples; i++) {
      if (i > 0 && cfg.sampleGapMs) await sleep(cfg.sampleGapMs);
      const top = await deps.readTopOfBook(c.productId);
      if (!top || !(top.bidPx > 0) || !(top.askPx > 0) || !(top.askPx > top.bidPx)) { ok = false; reject(c, "no live two-sided book"); break; }
      const spreadTicks = Math.round((top.askPx - top.bidPx) / c.tick);
      const mid = (top.bidPx + top.askPx) / 2;
      const fracOfMid = mid > 0 ? (top.askPx - top.bidPx) / mid : Infinity;
      if (cfg.maxSpreadFracOfMid !== undefined && fracOfMid > cfg.maxSpreadFracOfMid) { ok = false; reject(c, `mirage spread ${(fracOfMid * 100).toFixed(1)}% of mid`); break; }
      if (spreadTicks < cfg.spreadFloorTicks) { ok = false; reject(c, `spread ${spreadTicks}t < floor ${cfg.spreadFloorTicks}t`); break; }
      spreads.push(spreadTicks);
    }
    if (ok && spreads.length === samples) {
      qualified.push({ productId: c.productId, symbol: c.symbol, tick: c.tick, minSpreadTicks: Math.min(...spreads), spreadsTicks: spreads });
    }
  }
  if (!qualified.length) return null;
  // Prefer the highest stable (min) spread — the most reliably-above-floor genuine book; the
  // equity/FX/mirage books that used to win on raw width are already filtered out. Deterministic
  // tie-break on productId.
  qualified.sort((a, b) => (b.minSpreadTicks - a.minSpreadTicks) || (a.productId - b.productId));
  return qualified[0]!;
}
