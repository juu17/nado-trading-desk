// The self-cross load engine. A "round" trades every maker↔taker pair once: the maker rests a post-only
// order at a tick STRICTLY INSIDE the spread and the taker crosses it with an IOC hard-limited to that
// same price. Because the price sits between the real best bid and ask (≥1 tick from each), the maker
// rests alone there and the taker can reach only that maker — never third-party liquidity. A pair whose
// spread is too tight for an interior tick (or whose book is one-sided/empty) is SKIPPED, not forced.
// Each traded pair then flattens and clears any resting remainder, so the next round starts flat.
//
// This is the lean in-tab loop over the liveContext primitives — no node coordinator — driven by the
// sidebar's Run button. Wave B scope: ONE round, sequential pairs. Continuous rounds, the run/pause
// toggle, eligibility gating and the spend-caps/mainnet-confirm layer land in later waves.
import type { WalletVM } from "@farm/ui";
import { placeOrderLive, closePositionLive, cancelLive, marketTouchLive } from "./liveContext";
import { activeNetwork } from "./chainEnv";
import { shuffle } from "./rand";

export interface RoundConfig {
  /** Market id to trade (resolves to a live product; the whole round stays on this one market). */
  market: string;
  /** Per-pair USDT0 notional is drawn uniformly from [minNotional, maxNotional]. */
  minNotional: number;
  maxNotional: number;
  /** The round's side: true → makers buy / takers sell, false → the reverse. Re-rolled per round. */
  makerBuys: boolean;
}

export interface RoundHooks {
  /** Append one human-readable line to the sidebar automation log. */
  log: (msg: string) => void;
  /** Cooperative cancel — checked between pairs and threaded into every in-tab call (wired next wave). */
  signal?: AbortSignal;
}

export interface RoundResult {
  pairs: number;
  /** Pairs whose maker + taker both submitted (NOT a fill count — fills come from WS reconcile). */
  traded: number;
  /** Pairs skipped because the spread was too tight / the book one-sided for a clean self-cross. */
  skipped: number;
  errors: number;
}

const short = (w: WalletVM) => w.address.value.slice(0, 6);

const decimals = (tickStr: string): number => {
  const i = tickStr.indexOf(".");
  return i < 0 ? 0 : tickStr.length - i - 1;
};

/** The self-cross price: a tick STRICTLY inside the spread. A post-only order there does not cross (the
 *  real bid/ask are ≥1 tick away), and an IOC hard-limited to it can fill only against that resting order
 *  — the engine's own maker. Needs a ≥2-tick spread so an interior tick exists; returns null when the
 *  book is too tight or one-sided (the caller SKIPS that pair). Returns a tick-exact decimal STRING so
 *  placeOrderLive's fixed-point alignDown reproduces it with no float drift. Pure — unit-reasoned, and
 *  exercised end-to-end by the 1-tick-book e2e. */
export function interiorTickPrice(bid: number, ask: number, tick: number, tickStr: string): string | null {
  if (!(bid > 0) || !(ask > 0) || !(tick > 0)) return null; // empty / one-sided book
  const bidTicks = Math.round(bid / tick);
  const askTicks = Math.round(ask / tick);
  if (askTicks - bidTicks < 2) return null; // no tick strictly between bid and ask → can't self-cross cleanly
  const midTicks = Math.round((bidTicks + askTicks) / 2);
  const pTicks = Math.min(Math.max(midTicks, bidTicks + 1), askTicks - 1);
  return (pTicks * tick).toFixed(decimals(tickStr));
}

async function selfCrossPrice(walletId: string, market: string): Promise<{ price: string; priceNum: number } | null> {
  const touch = await marketTouchLive(walletId, market);
  if (!touch) throw new Error(`no live product for ${market}`);
  const price = interiorTickPrice(touch.bid, touch.ask, touch.tick, touch.tickStr);
  return price === null ? null : { price, priceNum: Number(price) };
}

/** Pair makers to takers 1:1 in shuffled order; min(count) pairs form and any surplus on the longer side
 *  sits the round out. Both sides are shuffled so pairings vary round to round. */
export function buildPairs(makers: readonly WalletVM[], takers: readonly WalletVM[]): Array<[WalletVM, WalletVM]> {
  const m = shuffle(makers);
  const t = shuffle(takers);
  const n = Math.min(m.length, t.length);
  const pairs: Array<[WalletVM, WalletVM]> = [];
  for (let i = 0; i < n; i++) pairs.push([m[i]!, t[i]!]);
  return pairs;
}

/** Trade one pair, or skip it when the spread can't host a clean self-cross. On ANY outcome the finally
 *  clears a resting maker remainder and flattens both wallets, so a mid-pair failure never leaks a live
 *  order or leaves inventory for the next round. */
async function runPair([maker, taker]: [WalletVM, WalletVM], i: number, cfg: RoundConfig, hooks: RoundHooks): Promise<"traded" | "skipped"> {
  const px = await selfCrossPrice(maker.id, cfg.market);
  if (!px) {
    hooks.log(`⊘ pair ${i + 1} skipped — spread too tight for a clean self-cross (${short(maker)} ↔ ${short(taker)}).`);
    return "skipped";
  }
  const notional = cfg.minNotional + Math.random() * (cfg.maxNotional - cfg.minNotional);
  const size = notional / px.priceNum;
  const makerSide = cfg.makerBuys ? "buy" : "sell";
  const takerSide = cfg.makerBuys ? "sell" : "buy";
  const tag = `pair${i + 1}-${Date.now()}`; // per-pair jobId → idempotent submits (byte-identical on retry)
  let makerPlaced = false;
  try {
    await placeOrderLive(maker.id, cfg.market, { side: makerSide, size, price: px.price, jobId: `${tag}-m`, signal: hooks.signal });
    makerPlaced = true;
    await placeOrderLive(taker.id, cfg.market, { side: takerSide, size, price: px.price, taker: true, jobId: `${tag}-t`, signal: hooks.signal });
    hooks.log(`✓ pair ${i + 1}: ${short(maker)} ${makerSide} ↔ ${short(taker)} ${takerSide} · ${notional.toFixed(0)} USDT0 @ ${px.price}`);
    return "traded";
  } finally {
    // The taker's IOC never rests, so only the maker can leave a resting remainder — cancel it before the
    // flatten reads the position. Flatten both (reduce-only crossing IOC; a no-op when already flat).
    if (makerPlaced) await cancelLive(maker.id, cfg.market, undefined, hooks.signal).catch(() => {});
    await closePositionLive(maker.id, cfg.market, hooks.signal).catch((e) => hooks.log(`⚠ flatten ${short(maker)} failed: ${(e as Error).message}`));
    await closePositionLive(taker.id, cfg.market, hooks.signal).catch((e) => hooks.log(`⚠ flatten ${short(taker)} failed: ${(e as Error).message}`));
  }
}

/** Run ONE round: trade every maker↔taker pair once, sequentially — the shared per-IP read budget and
 *  the per-wallet nonce lanes make concurrent pairs race, so pairs go one at a time. A pair that throws
 *  is logged and skipped; the round carries on. Testnet-gated: automated order placement on mainnet sits
 *  behind a typed confirm that a later wave adds, so until then the engine refuses off testnet (a backstop
 *  under the UI's own gate, so a non-UI caller can't bypass it). */
export async function runRound(makers: readonly WalletVM[], takers: readonly WalletVM[], cfg: RoundConfig, hooks: RoundHooks): Promise<RoundResult> {
  if (!activeNetwork().isTestnet) {
    hooks.log("✗ automation is testnet-only until the mainnet confirm step ships.");
    return { pairs: 0, traded: 0, skipped: 0, errors: 0 };
  }
  const pairs = buildPairs(makers, takers);
  if (pairs.length === 0) {
    hooks.log("No pairs — need at least one maker and one taker.");
    return { pairs: 0, traded: 0, skipped: 0, errors: 0 };
  }
  let traded = 0;
  let skipped = 0;
  let errors = 0;
  for (let i = 0; i < pairs.length; i++) {
    if (hooks.signal?.aborted) { hooks.log("stopped."); break; }
    try {
      if ((await runPair(pairs[i]!, i, cfg, hooks)) === "traded") traded++; else skipped++;
    } catch (e) {
      errors++;
      hooks.log(`✗ pair ${i + 1} failed: ${(e as Error).message}`);
    }
  }
  hooks.log(`round complete: ${traded}/${pairs.length} traded${skipped ? `, ${skipped} skipped` : ""}${errors ? `, ${errors} error(s)` : ""}`);
  return { pairs: pairs.length, traded, skipped, errors };
}
