// The self-cross load engine. A "round" trades every maker↔taker pair once: the maker rests a post-only
// order at a tick STRICTLY INSIDE the spread and the taker crosses it with an IOC hard-limited to that
// same price. Because the price sits between the real best bid and ask (≥1 tick from each), the maker
// rests alone there and the taker can reach only that maker — never third-party liquidity. A pair whose
// spread is too tight for an interior tick (or whose book is one-sided/empty) is SKIPPED, not forced.
// Each traded pair then flattens and clears any resting remainder, so the next round starts flat.
//
// This is the lean in-tab loop over the liveContext primitives — no node coordinator — driven by the
// sidebar's Run/Pause toggle: continuous rounds with per-wallet + per-cohort cumulative caps, a per-run
// typed-RUN confirm off testnet, and eligibility gating. Eligibility admits wallets WITH COLLATERAL
// (readiness funded|ready), not strict "ready": Nado orders are gasless, so collateral is the real
// requirement, and gas is stale-while-revalidate (a strict-ready gate would flakily skip tradeable
// wallets). A pair whose placement throws is retried a few times, then skipped.
import type { WalletVM } from "@farm/ui";
import { placeOrderLive, closePositionLive, cancelLive, marketTouchLive } from "./liveContext";
import { activeNetwork } from "./chainEnv";
import { shuffle } from "./rand";

/** Logged when the engine refuses an off-testnet run that wasn't confirmed — the UI's typed-RUN gate is
 *  the real guard; this backstop catches a non-UI caller. One string so UI + engine never drift. */
export const MAINNET_UNCONFIRMED_MSG = "✗ mainnet automation needs the typed RUN confirm.";

export interface RoundConfig {
  /** Market id to trade (resolves to a live product; the whole round stays on this one market). */
  market: string;
  /** Per-pair USDT0 notional is drawn uniformly from [minNotional, maxNotional]. */
  minNotional: number;
  maxNotional: number;
  /** The round's side: true → makers buy / takers sell, false → the reverse. Re-rolled per round. */
  makerBuys: boolean;
  /** Required to run off testnet — the UI sets it only after the per-run typed-RUN confirm. */
  mainnetConfirmed?: boolean;
}

export interface RoundHooks {
  /** Append one human-readable line to the sidebar automation log. */
  log: (msg: string) => void;
  /** Cooperative cancel — checked between pairs and threaded into the in-tab calls that start new work. */
  signal?: AbortSignal;
  /** Fires as each round begins — the filmstrip refills its drained queue. */
  onRoundStart?: () => void;
  /** Fires when a pair begins trading — the filmstrip moves it leftmost. */
  onPairStart?: (pair: readonly [WalletVM, WalletVM]) => void;
  /** Fires when a pair finishes — the filmstrip drains it; a "traded" one also feeds the metrics (+ ms). */
  onPairEnd?: (pair: readonly [WalletVM, WalletVM], outcome: "traded" | "skipped" | "error", ms: number) => void;
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

/** Consecutive rounds that trade nothing before the continuous loop gives up — tolerates a transient
 *  tight spread or sequencer blip, but stops when the market can't host a self-cross or every wallet is
 *  capped. */
const NO_TRADE_LIMIT = 3;

/** Extra attempts for a pair whose placement throws (a transient relay blip) before it's skipped. */
const PAIR_RETRIES = 2;

/** Cumulative spend ceilings for a run (USDT0 notional): per-wallet bounds any single wallet's total,
 *  per-cohort bounds each side's total. From net.caps; Infinity when unbounded. */
interface Caps { wallet: number; cohort: number }
/** Running totals for the current run: notional per wallet, and per cohort side. */
interface CapState { perWallet: Map<string, number>; maker: number; taker: number }

function freshCapState(): CapState { return { perWallet: new Map(), maker: 0, taker: 0 }; }

/** The reason a pair can't trade without breaching a cumulative cap, or null if it fits. */
function capReason(maker: WalletVM, taker: WalletVM, notional: number, caps: Caps, state: CapState): string | null {
  const total = (id: string): number => state.perWallet.get(id) ?? 0;
  if (total(maker.id) + notional > caps.wallet) return `${short(maker)} at its $${caps.wallet} wallet cap`;
  if (total(taker.id) + notional > caps.wallet) return `${short(taker)} at its $${caps.wallet} wallet cap`;
  if (state.maker + notional > caps.cohort) return `maker cohort at its $${caps.cohort} cap`;
  if (state.taker + notional > caps.cohort) return `taker cohort at its $${caps.cohort} cap`;
  return null;
}

/** Add a traded pair's notional to the per-wallet + per-cohort running totals. */
function bumpCaps(state: CapState, makerId: string, takerId: string, notional: number): void {
  state.perWallet.set(makerId, (state.perWallet.get(makerId) ?? 0) + notional);
  state.perWallet.set(takerId, (state.perWallet.get(takerId) ?? 0) + notional);
  state.maker += notional;
  state.taker += notional;
}

/** The subset of wallets eligible to trade — those with collateral (readiness "funded" or "ready"). Nado
 *  orders are gasless, so collateral is the real requirement; a wallet with none can't place. Logs each
 *  ineligible wallet's reason once, at run start. */
function eligible(wallets: readonly WalletVM[], role: string, hooks: RoundHooks): WalletVM[] {
  const ok: WalletVM[] = [];
  for (const w of wallets) {
    if (w.readiness !== "unfunded") ok.push(w);
    else hooks.log(`⊘ ${short(w)} (${role}) not eligible — no collateral.`);
  }
  return ok;
}

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
async function runPair([maker, taker]: [WalletVM, WalletVM], i: number, cfg: RoundConfig, hooks: RoundHooks, caps: Caps, state: CapState): Promise<"traded" | "skipped"> {
  const px = await selfCrossPrice(maker.id, cfg.market);
  if (!px) {
    hooks.log(`⊘ pair ${i + 1} skipped — spread too tight for a clean self-cross (${short(maker)} ↔ ${short(taker)}).`);
    return "skipped";
  }
  const notional = cfg.minNotional + Math.random() * (cfg.maxNotional - cfg.minNotional);
  // Cumulative caps: skip (don't place) a pair that would push a wallet or a cohort past its ceiling.
  const capped = capReason(maker, taker, notional, caps, state);
  if (capped) {
    hooks.log(`⊘ pair ${i + 1} skipped — ${capped}.`);
    return "skipped";
  }
  const size = notional / px.priceNum;
  const makerSide = cfg.makerBuys ? "buy" : "sell";
  const takerSide = cfg.makerBuys ? "sell" : "buy";
  const tag = `pair${i + 1}-${Date.now()}`; // jobId for placeOrderLive's own idempotent submit; a pair-level retry uses a fresh tag, and the finally cancels any maker a failed attempt left resting
  let makerSubmitted = false;
  try {
    makerSubmitted = true; // set BEFORE the await — a maker order that lands but whose call throws must still be cancelled
    await placeOrderLive(maker.id, cfg.market, { side: makerSide, size, price: px.price, jobId: `${tag}-m`, signal: hooks.signal });
    await placeOrderLive(taker.id, cfg.market, { side: takerSide, size, price: px.price, taker: true, jobId: `${tag}-t`, signal: hooks.signal });
    bumpCaps(state, maker.id, taker.id, notional); // count it only once both legs are in
    hooks.log(`✓ pair ${i + 1}: ${short(maker)} ${makerSide} ↔ ${short(taker)} ${takerSide} · ${notional.toFixed(0)} USDT0 @ ${px.price}`);
    return "traded";
  } finally {
    // Cleanup must NOT be cancellable by the same abort that triggers a Pause — otherwise a mid-pair
    // Pause would strand a resting maker order and un-flattened inventory. So the cancel + flattens run
    // with NO signal: abort stops NEW work, never the cleanup of work already placed. The taker's IOC
    // never rests, so only the maker can leave a resting remainder — cancel it before the flatten reads
    // the position; then flatten both (reduce-only crossing IOC; a no-op when already flat).
    if (makerSubmitted) await cancelLive(maker.id, cfg.market).catch((e) => hooks.log(`⚠ cancel ${short(maker)} failed: ${(e as Error).message}`));
    await closePositionLive(maker.id, cfg.market).catch((e) => hooks.log(`⚠ flatten ${short(maker)} failed: ${(e as Error).message}`));
    await closePositionLive(taker.id, cfg.market).catch((e) => hooks.log(`⚠ flatten ${short(taker)} failed: ${(e as Error).message}`));
  }
}

/** Run ONE round: trade every maker↔taker pair once, sequentially — the shared per-IP read budget and
 *  the per-wallet nonce lanes make concurrent pairs race, so pairs go one at a time. A pair that throws
 *  is logged and skipped; a pair that would breach a cumulative cap is skipped too; the round carries on.
 *  Off testnet the engine refuses unless cfg.mainnetConfirmed is set (the UI's typed-RUN gate), a backstop
 *  a non-UI caller can't bypass. caps/state default to unbounded + fresh for a standalone round. */
export async function runRound(makers: readonly WalletVM[], takers: readonly WalletVM[], cfg: RoundConfig, hooks: RoundHooks, caps: Caps = { wallet: Infinity, cohort: Infinity }, state: CapState = freshCapState()): Promise<RoundResult> {
  if (!activeNetwork().isTestnet && !cfg.mainnetConfirmed) {
    hooks.log(MAINNET_UNCONFIRMED_MSG);
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
    // Re-check the network each pair: a mid-round switch to mainnet (which doesn't carry this run's
    // confirm) stops the round at the next pair, not after it.
    if (!activeNetwork().isTestnet && !cfg.mainnetConfirmed) { hooks.log(MAINNET_UNCONFIRMED_MSG); break; }
    const pair = pairs[i]!;
    hooks.onPairStart?.(pair);
    const t0 = Date.now();
    // Retry a pair whose placement throws (a transient blip) a few times before giving up on it.
    let outcome: "traded" | "skipped" | undefined;
    for (let attempt = 0; attempt <= PAIR_RETRIES; attempt++) {
      try { outcome = await runPair(pair, i, cfg, hooks, caps, state); break; }
      catch (e) {
        if (hooks.signal?.aborted) break; // a pause, not a failure — the loop-top check ends the round
        if (attempt < PAIR_RETRIES) { hooks.log(`↻ pair ${i + 1} retry ${attempt + 1}/${PAIR_RETRIES}: ${(e as Error).message}`); continue; }
        errors++;
        hooks.log(`✗ pair ${i + 1} failed: ${(e as Error).message}`);
        break;
      }
    }
    if (outcome === "traded") traded++; else if (outcome === "skipped") skipped++;
    hooks.onPairEnd?.(pair, outcome ?? "error", Date.now() - t0);
  }
  hooks.log(`round complete: ${traded}/${pairs.length} traded${skipped ? `, ${skipped} skipped` : ""}${errors ? `, ${errors} error(s)` : ""}`);
  return { pairs: pairs.length, traded, skipped, errors };
}

/** Run rounds back to back until the signal aborts — the continuous benchmark loop behind the Run/Pause
 *  toggle. The round SIDE is re-rolled each round (so the maker cohort alternates between buying and
 *  selling over time), and abort is honored between rounds AND, via runRound, between pairs — so Pause
 *  stops within the current pair, not at the end of a long round. Max-throughput by design: no
 *  inter-round delay; the only pacing is the shared per-IP rate budget inside the in-tab primitives. */
export async function runContinuous(makers: readonly WalletVM[], takers: readonly WalletVM[], base: Omit<RoundConfig, "makerBuys">, hooks: RoundHooks): Promise<void> {
  const net = activeNetwork();
  if (!net.isTestnet && !base.mainnetConfirmed) {
    hooks.log(MAINNET_UNCONFIRMED_MSG);
    return;
  }
  const caps: Caps = { wallet: net.caps.walletUsdt0, cohort: net.caps.cohortUsdt0 };
  const state = freshCapState();
  // Eligibility: only wallets with collateral trade (orders are gasless, so gas isn't required). Snapshot
  // at run start — log each ineligible wallet once, then run the eligible subset.
  const eMakers = eligible(makers, "maker", hooks);
  const eTakers = eligible(takers, "taker", hooks);
  if (eMakers.length === 0 || eTakers.length === 0) {
    hooks.log("■ no eligible maker/taker pair — stopping.");
    hooks.log("■ stopped.");
    return;
  }
  let round = 0;
  let noTrade = 0;
  while (!hooks.signal?.aborted) {
    round++;
    hooks.onRoundStart?.();
    const makerBuys = Math.random() < 0.5;
    hooks.log(`▶ round ${round} — makers ${makerBuys ? "buy" : "sell"}`);
    const r = await runRound(eMakers, eTakers, { ...base, makerBuys }, hooks, caps, state);
    // Stop when the run can't make progress: an empty cohort, a cohort that hit its cumulative cap, or a
    // run of consecutive rounds that trade nothing (a tight market or every wallet capped) — a single
    // transient dead round is tolerated. A normal round keeps looping (the setTimeout(0) yields between).
    if (r.pairs === 0) { hooks.log("■ nothing to trade — stopping."); break; }
    if (state.maker >= caps.cohort || state.taker >= caps.cohort) { hooks.log(`■ cohort spend cap ($${caps.cohort}) reached — stopping.`); break; }
    noTrade = r.traded === 0 ? noTrade + 1 : 0;
    if (noTrade >= NO_TRADE_LIMIT) { hooks.log(`■ no pairs traded in ${NO_TRADE_LIMIT} rounds — stopping.`); break; }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  hooks.log("■ stopped.");
}
