// =============================================================================
// CLIENT live composition root (the custody graduation, complete). The SAME
// NadoAdapter + core plan runner that the offline console uses, but wired to:
//   • the IN-TAB custody signer (key never leaves the browser), and
//   • a relay-backed NadoGateway (reads + writes go to the KEYLESS relay, which
//     forwards signed bytes / public queries to the sequencer).
// So place / cancel / close, funding (deposit on-chain, withdraw via the sequencer)
// and reads all run in the operator's tab and sign in-tab — the server holds no key
// and signs nothing. Browser-only module (imports custody).
// =============================================================================
import {
  WativeChainRegistry, defaultChainOverlay, WativePlanRunner, SerialNonceLane, RateLimiter,
} from "@farm/core";
import type { OnchainExecutor } from "@farm/core";
import { NadoAdapter, createLiveNadoGateway, NADO_MANIFEST, buildWithdrawTypedData, clampOrderSize } from "@farm/adapter-nado";
import type { TransportLike } from "@farm/adapter-nado";
import { EngineClient } from "@nadohq/engine-client";
import { getOrderNonce } from "@nadohq/client";
import type { SignerContext, PlaceOrderInput, Decimal, ChainId, Order, Position, Balance, MarketId, OrderBook } from "@farm/adapter-api";
import type { Address as WativeAddress, ChainId as WativeChainId } from "wative-core";
import { parseUnits, formatUnits, toHex, parseEther } from "viem";
import { signerForWalletId, evmAddressForWalletId } from "./custody";
import { getLiveConfig, productFor } from "./liveConfig";
import type { LiveConfig, LiveProductVM } from "./liveConfig";
import { activeNetwork } from "./chainEnv";

// Mutable per-operation chain config, mirrored from the SELECTED network. A live network switch
// calls refreshNetwork() so the in-tab money path (chainId / RPC / USDT0 / caps) tracks the UI
// toggle WITHOUT a reload — the unlocked vault + its keys are chain-agnostic and stay put. Every
// use site below reads these module vars at call time, so a switch takes effect on the next op.
let NET = activeNetwork();
let CHAIN = NET.chainId;     // the live order chainId (account.chainId + step.chainId)
let INK_RPC = NET.rpc;
let USDT0 = NET.usdt0;
let IS_TESTNET = NET.isTestnet;
let CHAIN_LABEL = NET.label;
let MAX_ORDER_NOTIONAL_USDT0 = NET.caps.orderNotionalUsdt0;
let MAX_DEPOSIT_USDT0 = NET.caps.depositUsdt0;
let MAX_REFUEL_ETH = NET.caps.refuelEth;
let MAX_REFUEL_WEI = NET.caps.refuelWei;
let MAX_COHORT_USDT0 = NET.caps.cohortUsdt0;

/** Re-read the selected network after a live switch (the UI network toggle calls this, then refreshLive). */
export function refreshNetwork(): void {
  NET = activeNetwork();
  CHAIN = NET.chainId; INK_RPC = NET.rpc; USDT0 = NET.usdt0; IS_TESTNET = NET.isTestnet; CHAIN_LABEL = NET.label;
  MAX_ORDER_NOTIONAL_USDT0 = NET.caps.orderNotionalUsdt0; MAX_DEPOSIT_USDT0 = NET.caps.depositUsdt0;
  MAX_REFUEL_ETH = NET.caps.refuelEth; MAX_REFUEL_WEI = NET.caps.refuelWei; MAX_COHORT_USDT0 = NET.caps.cohortUsdt0;
}
const CHAIN_PLACEHOLDER = 57073; // a builtin chain only to satisfy ctx.chain; UNUSED on the off-chain order path
const RELAY = "/api/nado/relay";

// ---- Stage 2b IN-TAB FUNDING constants ----------------------------------------------
// INK_RPC (CORS-open Ink RPC) + USDT0 (6-dec collateral token) now come from ./chainEnv
// (the single env source) so they switch in lockstep with CHAIN; defaults are testnet.
const QUOTE_PRODUCT = 0;     // the USDT0 quote/collateral product id
const SUBACCT = "default";   // Nado's per-EOA subaccount
const MAX_UINT = (1n << 256n) - 1n;
// ---- Stage 3b GAS-REFUEL constants ----------------------------------------------------
// The in-tab gas TREASURY (fund-cohort convention). It is the SOURCE of refuel ETH and must be
// externally funded — refuel moves gas FROM it to a recipient wallet, it does not create ETH.
export const TREASURY_WALLET_ID = "live:0";
// Native ETH per operator-triggered top-up (~3x the on-chain bootstrap floor of 0.00003 — headroom for
// a few approve/deposit cycles). Operator-editable in the UI.
export const DEFAULT_REFUEL_ETH = "0.0001";
// Per-wallet defaults for the bulk cohort-funding path (testnet). Operator-editable in the FundingPanel.
export const DEFAULT_MINT_USDT0 = "100";
export const DEFAULT_DEPOSIT_USDT0 = "50";
// Minimal ERC-20 slice: balanceOf + allowance read + approve (deposit path) + mint (TESTNET faucet — the
// USDT0 test token is openly mintable, no minter role; see mintUsdt0Live). This LOCAL abi backs approve +
// mint + the balanceOf skip-check; wative's ready-made ERC20 artifact omits the non-standard `mint`.
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
] as const;

// ---- helpers (human-decimal tick/step alignment; size clamp to the market min) -------
function alignDown(valHuman: string, incHuman: string): string {
  const inc = parseUnits(incHuman, 18);
  if (inc <= 0n) return valHuman;
  const v = parseUnits(valHuman, 18);
  return formatUnits((v / inc) * inc, 18);
}
// Clamp an operator size to a valid, placeable base size. Delegates to the adapter's
// unit-correct helper: floor to one step, then (given the resolved price + the market's min
// NOTIONAL) bump up to clear the min notional. The min-notional bump needs the price, so the
// caller resolves price BEFORE clamping.
function clampSize(product: LiveProductVM, uiSize: string | number | undefined, price?: string | number): string {
  return clampOrderSize(uiSize, { stepSize: product.stepSize, minSize: product.minSize, price, minNotional: product.minNotional });
}

// ONE shared client-side rate budget across the whole in-tab cohort, registered from the
// Nado manifest buckets — so the cohort's reads/market-price AND writes respect the
// sequencer's per-IP limits instead of bursting into 429s.
const limiter = new RateLimiter().register(NADO_MANIFEST.rateLimits);

// ---- client transport for the relay gateway (WRITES: submit/cancel) -------------------
// The gateway tags each write with its bucket (submit=nado:place, cancel=nado:rest). We
// METER writes against that bucket here — otherwise a cohort-wide order/cancel burst (the
// kill switch's highest fan-out) hits the sequencer with zero client pacing, relying solely
// on the relay's 429 retry. We also THROW on a non-2xx relay response (502 network error,
// exhausted-429, …) so a failed write becomes a FAILED job, never a silent
// {digest:"",status:"open"} success. (Reads meter directly in the gateway.)
const transport: TransportLike = {
  async request<T>(a: { method: "GET" | "POST"; url: string; body?: unknown; signal?: AbortSignal; bucket?: string; weight?: number; key?: string }): Promise<T> {
    if (a.bucket) await limiter.acquire(a.bucket, a.weight ?? 1, a.key, a.signal);
    const r = await fetch(a.url, {
      method: a.method, headers: { "content-type": "application/json" },
      body: a.body != null ? JSON.stringify(a.body) : undefined, signal: a.signal,
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`relay ${r.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    return (await r.json()) as T;
  },
};

// ---- shared infra (built once) -------------------------------------------------------
let shared: { registry: WativeChainRegistry; runner: WativePlanRunner; lane: SerialNonceLane } | null = null;
function infra() {
  if (!shared) {
    // The off-chain order path never reads ctx.chain (the runner signs with step.chainId),
    // so a builtin registry suffices; no testnet RPC entry is needed client-side.
    const registry = WativeChainRegistry.fromBuiltins(defaultChainOverlay());
    const onchain: OnchainExecutor = { send: async () => { throw new Error("client live: on-chain tx path is Stage 2b (orders are off-chain)"); } };
    shared = { registry, runner: new WativePlanRunner(onchain), lane: new SerialNonceLane() };
  }
  return shared;
}

// ---- per-wallet live context (adapter + ctx + engine), cached by wallet+owner ---------
interface Live { adapter: NadoAdapter; ctx: SignerContext; engine: EngineClient; }
const cache = new Map<string, Live>();

async function liveFor(walletId: string): Promise<{ live: Live; cfg: LiveConfig }> {
  const cfg = await getLiveConfig();
  if (!cfg.enabled) throw new Error("live mode disabled");
  // 🚨 Half-flip guard: the client's CHAIN is the selected network (cookie); the server reports the
  // chainId it resolved for THIS request (same cookie). If they disagree, the tab would sign for one
  // chain while the relay forwards to another (→ sequencer 2093 / invalid signature, or worse on
  // mainnet). Refuse loudly rather than sign on the wrong chain — e.g. a switch that didn't fully
  // apply (call refreshNetwork() + refreshLive() after setActiveChainId()).
  if (cfg.chainId != null && cfg.chainId !== CHAIN) {
    throw new Error(
      `chain mismatch: the client is on chainId ${CHAIN} but the server resolved ${cfg.chainId} — ` +
      `re-select the network (the switch didn't fully apply) before trading`,
    );
  }
  const signer = signerForWalletId(walletId); // in-tab; throws if the cohort is locked
  const owner = signer.address.value;
  const ck = `${walletId}:${owner}`;
  let live = cache.get(ck);
  if (!live) {
    const productIds = Object.fromEntries((cfg.products ?? []).map((p) => [p.marketId, p.productId])) as Record<MarketId, number>;
    const engine = new EngineClient({ url: RELAY }); // reads → relay /query
    const gateway = createLiveNadoGateway({
      engine, transport, limiter, engineUrl: RELAY, chainId: CHAIN,
      endpoint: cfg.endpoint ?? "", owner, markets: cfg.markets ?? [], productIds,
    });
    const adapter = new NadoAdapter({ gateway, productIds, endpoint: cfg.endpoint });
    const { registry, runner, lane } = infra();
    const ctx: SignerContext = {
      signer,
      account: { protocolId: "nado", chainId: CHAIN as ChainId, owner: signer.address, subaccount: { id: "default", owner: signer.address, label: "default", raw: null }, raw: null },
      chain: registry.require(CHAIN_PLACEHOLDER as ChainId), // unused on the order path (see note above)
      walletId,
      onchainNonces: lane,
      protocolNonces: { timestamp: () => BigInt(Date.now()), nextProtocolSeq: async () => 0 },
      runner,
    };
    live = { adapter, ctx, engine };
    cache.set(ck, live);
  }
  return { live, cfg };
}

/** Drop a wallet's cached context (call after a re-import / lock). */
export function resetLiveContexts(): void { cache.clear(); }

// Session idempotency (client-side): jobId → the order it produced, so a kill/resume
// re-queue (or a double-send) returns the prior order instead of firing a new one.
const submitted = new Map<string, Order>();

// jobId → the FULLY-RESOLVED order (nonce, expiration, AND the resolved price + size). A
// retry of a failed job (same jobId) rebuilds the BYTE-IDENTICAL signed order — same digest
// across EVERY path, including a book-derived (market/no-price) order whose book has since
// moved — and reuses the stored price/size instead of re-reading the book. The sequencer
// dedups the identical digest (engine code 2013 DIGEST_ALREADY_EXISTS), so a 502-after-accept
// retry cannot double-place; a retry past the ~90s recvTime window (2011 LATE_RECV_EXECUTION)
// or past expiry (2004) fails SAFE (no re-place, no double). NB the guarantee hinges on those
// engine codes, and the effective clean-re-place window is ~90s (the nonce's recvTime), NOT
// the 7-day expiration. In-memory only: consistent with today's InMemoryJobStore, but if a
// persisted job store (recover-after-reload) is ever adopted this map must be persisted too,
// else a post-reload retry re-mints and the double-place returns (tracked follow-up).
const ORDER_TTL_SECS = 7 * 24 * 60 * 60; // the order's expiration (resting-maker default); the re-place window is the ~90s recvTime
interface StableOrder { nonce: string; expiration: string; price: string; size: string; reduceOnly?: boolean }
const orderParamStore = new Map<string, StableOrder>();

interface BidAsk { bid?: { toFixed(d?: number): string } | string | number; ask?: { toFixed(d?: number): string } | string | number }
function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "object" && "toFixed" in (v as object)) return Number((v as { toFixed(): string }).toFixed());
  return Number(v);
}
async function marketPrice(engine: EngineClient, productId: number): Promise<{ bid: number; ask: number }> {
  await limiter.acquire("nado:rest", 1); // metered like the other reads (avoids the 429 that zeroes the fallback)
  const mp = (await engine.getMarketPrice({ productId })) as unknown as BidAsk;
  return { bid: num(mp.bid), ask: num(mp.ask) };
}

export interface PlaceOpts { side: "buy" | "sell"; size?: string | number; price?: string | number; taker?: boolean; reduceOnly?: boolean; jobId?: string; signal?: AbortSignal }

/** Place an order IN-TAB: sign client-side → submit through the keyless relay. The
 *  OPERATOR's price wins (tick-aligned); a taker crosses; only with no operator price
 *  do we fall back to a book-derived resting maker. */
export async function placeOrderLive(walletId: string, marketId: string | undefined, opts: PlaceOpts): Promise<Order> {
  if (opts.signal?.aborted) throw new Error("aborted");
  const { live, cfg } = await liveFor(walletId);
  const product = productFor(cfg, marketId);
  if (!product) throw new Error("no live product");
  const taker = opts.taker === true;
  const idemKey = opts.jobId ? `${walletId}:${opts.jobId}` : undefined;
  if (idemKey && submitted.has(idemKey)) return submitted.get(idemKey)!;

  // Build the FULL order params once, then REUSE them on any retry of the same jobId so the
  // rebuilt order is byte-identical (same digest) regardless of market moves — this includes
  // the resolved price + size, not just the nonce/expiration, so a book-derived (market /
  // no-price) order can't re-price on retry and slip past the digest dedup. On a retry we
  // reuse the stored price/size and skip the book re-read entirely.
  let built = idemKey ? orderParamStore.get(idemKey) : undefined;
  if (!built) {
    let human: string;
    if (opts.price != null && Number(opts.price) > 0) {
      human = String(opts.price);
    } else {
      const { bid, ask } = await marketPrice(live.engine, product.productId);
      if (taker) {
        human = opts.side === "buy" ? String(ask * 1.002) : String(bid * 0.998);
      } else {
        const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (bid > 0 ? bid : ask);
        human = String(opts.side === "buy" ? mid * 0.9 : mid * 1.1);
      }
    }
    const price = alignDown(human, product.tickSize);
    // Size is resolved AFTER the price so clampSize can bump it up to clear the market's min
    // NOTIONAL at this price (Nado's `minSize` is a USDT0 notional floor, not a base size).
    const size = clampSize(product, opts.size, price);
    // reduceOnly is a digest field (it sets the appendix bit), so it is part of the stable
    // per-jobId order too — a retry reuses the first value and stays byte-identical.
    built = { price, size, reduceOnly: opts.reduceOnly, nonce: String(getOrderNonce()), expiration: String(Math.floor(Date.now() / 1000) + ORDER_TTL_SECS) };
    if (idemKey) orderParamStore.set(idemKey, built);
  }
  // Spend cap: reject (never clamp) an order whose notional exceeds the ceiling. Computed from
  // the resolved+clamped values that actually get signed (both HUMAN decimals), so it covers the
  // operator-price, taker and book-derived branches alike. Applies to ALL orders — reduce-only
  // closes included (operator chose maximal strictness: a position larger than the cap must be
  // flattened in cap-sized chunks). A retry of a succeeded order already returned above (idempotent),
  // so the cap never blocks completing an order that was already placed.
  const notionalUsdt0 = Number(built.price) * Number(built.size);
  if (notionalUsdt0 > MAX_ORDER_NOTIONAL_USDT0) {
    throw new Error(`order notional ${notionalUsdt0} USDT0 exceeds cap ${MAX_ORDER_NOTIONAL_USDT0} (NEXT_PUBLIC_NADO_MAX_ORDER_NOTIONAL_USDT0)`);
  }
  if (opts.signal?.aborted) throw new Error("aborted");
  const input: PlaceOrderInput = {
    market: product.marketId as MarketId, side: opts.side, kind: "limit",
    size: built.size as Decimal, price: built.price as Decimal,
    postOnly: !taker, tif: taker ? "ioc" : undefined, reduceOnly: built.reduceOnly,
    clientId: opts.jobId ?? `tab:${walletId}:${Date.now()}`,
    // Stabilize the digest only for jobId'd (retryable) orders; manual fires keep a fresh nonce.
    hints: idemKey ? { nonce: built.nonce, expiration: built.expiration } : undefined,
  };
  const order = await live.adapter.trading.placeOrder(live.ctx, input);
  if (idemKey) submitted.set(idemKey, order);
  return order;
}

/** Cancel the wallet's open orders on a market IN-TAB (all, or a specific venueId). */
export async function cancelLive(walletId: string, marketId: string | undefined, venueId?: string, signal?: AbortSignal): Promise<{ cancelled: string[] }> {
  if (signal?.aborted) throw new Error("aborted");
  const { live } = await liveFor(walletId);
  let venueIds: string[];
  if (venueId) {
    venueIds = [venueId];
  } else {
    const open = await live.adapter.trading.getOpenOrders(live.ctx.account);
    venueIds = open.filter((o) => !marketId || o.market === marketId).map((o) => o.venueId).filter((v): v is string => Boolean(v));
  }
  if (venueIds.length === 0) return { cancelled: [] };
  return live.adapter.trading.cancelOrders(live.ctx, { market: marketId as MarketId | undefined, venueIds });
}

/** Flatten the wallet's position on a market with an opposite crossing IOC, IN-TAB. */
export async function closePositionLive(walletId: string, marketId: string | undefined, signal?: AbortSignal): Promise<{ closed: number; order?: Order; side?: "buy" | "sell" }> {
  if (signal?.aborted) throw new Error("aborted");
  const { live, cfg } = await liveFor(walletId);
  const product = productFor(cfg, marketId);
  if (!product) throw new Error("no live product");
  const positions = await live.adapter.trading.getPositions(live.ctx.account);
  const pos = positions.find((p) => p.market === product.marketId);
  const amt = pos ? Number(pos.size) * (pos.side === "short" ? -1 : 1) : 0;
  if (!(Math.abs(amt) > 0)) return { closed: 0 };
  const side: "buy" | "sell" = amt > 0 ? "sell" : "buy";
  // reduceOnly: the venue caps the fill at the position, so a crossing IOC on a thin book
  // flattens without ever overshooting into an opposite position.
  const order = await placeOrderLive(walletId, product.marketId, { side, size: Math.abs(amt), taker: true, reduceOnly: true, signal });
  return { closed: amt, order, side };
}

// A failed sub-read is `undefined` (NOT []), so a merge keeps the prior value instead of
// blanking the card — a transient 429 on one read must not flicker a wallet to empty.
export interface WalletReads { openOrders?: Order[]; balances?: Balance[]; positions?: Position[]; native?: Decimal }

// Native (ETH) gas is read KEYLESS (eth_getBalance to the CORS-open Ink RPC — NOT the scarce sequencer
// relay budget), TTL-cached per wallet (it changes only on deposit/withdraw/refuel). The read is
// NON-CRITICAL (a display-only readiness badge), so it is STALE-WHILE-REVALIDATE and never shares the
// critical trading-state read batch: a stale/cold miss serves the cache and kicks a BACKGROUND refresh
// rather than blocking. The background fetch is TIMEOUT-bounded (a hung public RPC aborts, never
// stalls the serial sweep) and IN-FLIGHT-deduped (concurrent sweep + WS reconciles of one wallet
// collapse to a single fetch). Wave 3b's refuel is prepared to invalidate the cache after a top-up.
const nativeCache = new Map<string, { value: Decimal; ts: number }>();
const nativeInflight = new Map<string, Promise<Decimal | undefined>>();
const NATIVE_TTL_MS = 30_000;
const NATIVE_TIMEOUT_MS = 6_000;
export function invalidateNativeBalance(walletId: string): void { nativeCache.delete(walletId); }

/** The per-subaccount DIRECT DEPOSIT ADDRESS for a wallet `owner` — a keyless indexer read via the
 *  /api/nado/dda server route (the indexer is a different host than the engine relay). Send USDT0 here
 *  to fund this wallet's subaccount. Returns null on any failure (it is display-only). */
export async function depositAddressLive(owner: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const r = await fetch(`/api/nado/dda?owner=${encodeURIComponent(owner)}`, { cache: "no-store", signal });
    const j = (await r.json()) as { address?: string; error?: string };
    return r.ok && j.address ? j.address : null;
  } catch { return null; }
}

// Bound a per-call RPC read by BOTH the caller's abort signal (kill switch) AND an independent timeout, so
// a hung public RPC fails fast on its own instead of stalling a sequential bulk run until the operator
// aborts. (A plain `signal ?? timeout` drops the timeout whenever a signal is passed — which the bulk path
// always does — so these must be COMBINED, not either-or.)
function readSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(NATIVE_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchNativeWei(owner: string, signal?: AbortSignal): Promise<bigint> {
  const res = await fetch(INK_RPC, {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [owner, "latest"] }),
  });
  const j = (await res.json()) as { result?: string; error?: { message?: string } };
  if (j.error) throw new Error(`native balance read failed: ${j.error.message ?? "rpc error"}`);
  return j.result ? BigInt(j.result) : 0n;
}

/** Refresh ONE wallet's native balance from the RPC — timeout-bounded + in-flight-deduped. Updates the
 *  cache on success; swallows failures (the prior cache stands). Never throws, never blocks a caller. */
function refreshNative(walletId: string): Promise<Decimal | undefined> {
  const existing = nativeInflight.get(walletId);
  if (existing) return existing;
  const p = (async (): Promise<Decimal | undefined> => {
    try {
      const owner = evmAddressForWalletId(walletId).publicKey;
      return formatUnits(await fetchNativeWei(owner, AbortSignal.timeout(NATIVE_TIMEOUT_MS)), 18) as Decimal;
    } catch {
      return undefined;
    }
  })().then((eth) => {
    if (eth !== undefined) nativeCache.set(walletId, { value: eth, ts: Date.now() });
    nativeInflight.delete(walletId);
    return eth;
  });
  nativeInflight.set(walletId, p);
  return p;
}

/** This wallet's native (ETH) gas balance, STALE-WHILE-REVALIDATE so it NEVER blocks the critical
 *  trading-state reconcile: a fresh cached value returns at once; a stale one is served while a
 *  background refresh runs; a cold miss returns undefined now (→ a conservative `unfunded`) and the
 *  real value lands on the next reconcile pass (the sweep is a continuous round-robin). Synchronous —
 *  it only ever reads the cache and (on a miss) fires a non-blocking background refresh. */
function readNative(walletId: string): Decimal | undefined {
  const cached = nativeCache.get(walletId);
  if (cached && Date.now() - cached.ts < NATIVE_TTL_MS) return cached.value; // fresh
  void refreshNative(walletId);                                              // cold/stale → background refresh
  return cached?.value;                                                      // serve stale if present, else undefined
}

/** Force a FRESH native read NOW (bypasses the TTL) and resolve with the new value — used right after a
 *  refuel so the recipient + treasury gas badges repaint immediately instead of waiting out the SWR TTL.
 *  Timeout-bounded + in-flight-deduped via refreshNative. */
export async function forceRefreshNative(walletId: string): Promise<Decimal | undefined> {
  nativeCache.delete(walletId);
  return refreshNative(walletId);
}
/** Read one in-tab wallet's live state (open orders / balances / positions) via the relay.
 *  balances + positions BOTH derive from the subaccount summary; the live gateway
 *  single-flights that read, so this fires ONE summary fetch per wallet per reconcile (plus
 *  the multi-product open-orders read) instead of two. The native-gas read is DELIBERATELY not in
 *  this batch — it is stale-while-revalidate (see readNative), so a slow public RPC can never delay
 *  the critical orders/balances/positions reconcile. */
export async function readWalletLive(walletId: string): Promise<WalletReads> {
  const { live } = await liveFor(walletId);
  const [openOrders, balances, positions] = await Promise.all([
    live.adapter.trading.getOpenOrders(live.ctx.account).catch(() => undefined),
    live.adapter.getBalances(live.ctx.account).catch(() => undefined),
    live.adapter.trading.getPositions(live.ctx.account).catch(() => undefined),
  ]);
  const native = readNative(walletId); // non-blocking: cache read + background refresh on miss
  return { openOrders, balances, positions, native };
}

/** Read a market's order book via the relay (getMarketLiquidity). The query itself is keyless (the
 *  gateway uses only engine + limiter + productId, no signer/owner/subaccount), but it reuses the
 *  given wallet's ALREADY-UNLOCKED context (liveFor requires an unlocked cohort). Per-MARKET, not
 *  per-wallet — the EngineClient is stateless for market reads, so any unlocked wallet's context
 *  yields the same book. Returns undefined on a transient failure; the caller decides keep-vs-clear. */
export async function readOrderBookLive(walletId: string, marketId: string, depth = 10): Promise<OrderBook | undefined> {
  try {
    const { live } = await liveFor(walletId);
    return await live.adapter.trading.getOrderBook(marketId as MarketId, depth);
  } catch {
    return undefined;
  }
}

/** Remaining tokens in the shared per-IP read budget — the sweep gates on this to reserve
 *  headroom for interactive ops (cancels/kill-switch, drawer reads) so it can't starve them. */
export function readBudget(): number {
  return limiter.available("nado:rest");
}

// =============================================================================
// Stage 2b — IN-TAB FUNDING (deposit on-chain, withdraw via the sequencer).
// The key stays SEALED inside the in-tab wative signer: deposit builds + signs the
// on-chain tx through wative (Contract.call → sign) and broadcasts via a KEYLESS
// ChainClient; withdraw signs a Nado EIP-712 IN-TAB and injects the signature into the
// SDK payload (no walletClient), POSTing through the keyless relay. The server holds no
// key and does no signing for either path.
// =============================================================================
export interface FundingResult { ok: boolean; tx?: string; status?: string; error?: string }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface MinReceipt { status?: unknown }
function receiptSucceeded(r: unknown): boolean {
  const s = (r as MinReceipt)?.status;
  return s === 1 || s === 1n || s === "0x1" || s === "success" || s === true;
}

/** Poll a keyless ChainClient for a broadcast tx's receipt until mined (or timeout). */
async function waitForReceipt(
  chain: { getTransactionReceipt(hash: string): Promise<unknown | null> },
  hash: string,
  opts: { tries?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<{ mined: boolean; success: boolean }> {
  const tries = opts.tries ?? 40;
  const intervalMs = opts.intervalMs ?? 1500;
  for (let i = 0; i < tries; i++) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const r = await chain.getTransactionReceipt(hash).catch(() => null);
    if (r) return { mined: true, success: receiptSucceeded(r) };
    await sleep(intervalMs);
  }
  return { mined: false, success: false };
}

/** Keyless ERC-20 allowance read via a direct eth_call to the CORS-open Ink RPC. */
async function readAllowance(
  erc20: { encode(fn: string, args: unknown[]): string; decode(fn: string, hex: string): readonly unknown[] },
  owner: string,
  spender: string,
  signal?: AbortSignal,
): Promise<bigint> {
  const data = erc20.encode("allowance", [owner, spender]);
  const res = await fetch(INK_RPC, {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDT0, data }, "latest"] }),
  });
  const j = (await res.json()) as { result?: string; error?: { message?: string } };
  if (j.error) throw new Error(`allowance read failed: ${j.error.message ?? "rpc error"}`);
  if (!j.result || j.result === "0x") return 0n;
  const [val] = erc20.decode("allowance", j.result);
  return BigInt(String(val));
}

/** DEPOSIT collateral IN-TAB: approve (if needed) + Endpoint.depositCollateral, built +
 *  signed by the sealed in-tab wative signer, broadcast by a keyless ChainClient to the
 *  Ink RPC. The private key never leaves the tab; the server is not involved. */
export async function depositLive(walletId: string, amount: string, signal?: AbortSignal): Promise<FundingResult> {
  const { cfg } = await liveFor(walletId); // asserts live is enabled + yields the endpoint
  const endpoint = cfg.endpoint;
  if (!endpoint) return { ok: false, error: "no live endpoint configured" };
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: "amount must be a positive number" };
  // Spend cap: loud reject (never clamp) a deposit over the ceiling.
  if (amt > MAX_DEPOSIT_USDT0) return { ok: false, error: `deposit ${amt} USDT0 exceeds cap ${MAX_DEPOSIT_USDT0} (NEXT_PUBLIC_NADO_MAX_DEPOSIT_USDT0)` };

  const evm = evmAddressForWalletId(walletId) as unknown as WativeAddress;
  const owner = (evm as unknown as { publicKey: string }).publicKey;
  // wative-core browser build is lazy-loaded (heavy; IndexedDB) — matches custody.ts.
  const { Network, ChainClient, Contract } = await import("wative-core");
  const { ENDPOINT_ABI, subaccountNameToBytes12 } = await import("@nadohq/client");

  const inkNet = new Network(CHAIN_LABEL, CHAIN, INK_RPC, { name: "Ether", symbol: "ETH", decimals: 18 });
  const chain = new ChainClient(inkNet);
  const amt6 = parseUnits(amount, 6);
  // Build EVERY tx for Ink explicitly (chainId + rpcUrl overrides), so the autofill +
  // sign target the Ink RPC regardless of the in-tab wallet's bound network.
  const buildOpts = { chainId: CHAIN as unknown as WativeChainId, rpcUrl: INK_RPC };

  try {
    // 1 — allowance (keyless eth_call) → approve MAX if short. Approve MUST confirm
    //     before the deposit builds, so the deposit's gas estimate (which reads the
    //     allowance) succeeds and the nonce auto-fill reads the post-approve pending nonce.
    const erc20 = new Contract("USDT0", ERC20_ABI as never);
    const allowance = await readAllowance(erc20 as never, owner, endpoint, signal);
    if (allowance < amt6) {
      const approveTx = erc20.call(evm, USDT0, "approve", [endpoint, MAX_UINT], buildOpts);
      await approveTx.sign();
      const raw = approveTx.rawTransaction;
      if (!raw) return { ok: false, error: "approve did not produce signed bytes" };
      const ah = await chain.broadcast(raw);
      const ar = await waitForReceipt(chain, ah, { signal });
      if (!ar.success) return { ok: false, tx: ah, error: `approve ${ar.mined ? "reverted" : "timed out"} (${ah})` };
    }

    // 2 — Endpoint.depositCollateral(subaccountNameBytes12, productId, amount6).
    const sub12 = toHex(subaccountNameToBytes12(SUBACCT) as Uint8Array);
    const endpointC = new Contract("Endpoint", ENDPOINT_ABI as never);
    const depTx = endpointC.call(evm, endpoint, "depositCollateral", [sub12, QUOTE_PRODUCT, amt6], buildOpts);
    await depTx.sign();
    const raw = depTx.rawTransaction;
    if (!raw) return { ok: false, error: "deposit did not produce signed bytes" };
    const dh = await chain.broadcast(raw);
    const r = await waitForReceipt(chain, dh, { signal });
    if (!r.mined) return { ok: false, tx: dh, status: "pending", error: `deposit confirmation timed out (${dh})` };
    return { ok: r.success, tx: dh, status: r.success ? "success" : "reverted" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// All refuels from ONE treasury EOA must SERIALIZE: wative autofills the pending nonce at sign time, so
// concurrent operator triggers would read the SAME nonce and collide on-chain. This per-treasury
// promise-chain makes each refuel wait for the prior to SETTLE (through its receipt) before it builds +
// signs the next, so the pending-nonce autofill always sees the incremented value. Self-healing: a
// failed/timed-out send still advances the lane (no stuck local nonce counter to desync on reload).
const treasuryLane = new Map<string, Promise<unknown>>();
function serializeOnTreasury<T>(treasuryWalletId: string, job: () => Promise<T>): Promise<T> {
  const prev = treasuryLane.get(treasuryWalletId) ?? Promise.resolve();
  const run = prev.then(job, job); // run after the prior settles, whether it resolved or rejected
  treasuryLane.set(treasuryWalletId, run.then(() => {}, () => {})); // keep the lane alive past any failure
  return run;
}

/** REFUEL native ETH gas IN-TAB: send ETH from a designated TREASURY wallet to a recipient wallet that
 *  is low on gas, so it can run the on-chain funding bootstrap (approve + deposit). Built + signed by
 *  the SEALED treasury signer, broadcast by a keyless ChainClient to the Ink RPC — the key never leaves
 *  the tab. A native value transfer is a strict subset of depositLive (no contract/calldata).
 *  Operator-triggered only (no auto-refuel in v1) and SERIALIZED per-treasury (one EOA = one nonce). */
export async function refuelGasLive(
  recipientWalletId: string,
  opts: { amountEth?: string; treasuryWalletId?: string; signal?: AbortSignal } = {},
): Promise<FundingResult> {
  const treasuryWalletId = opts.treasuryWalletId ?? TREASURY_WALLET_ID;
  const amountEth = opts.amountEth ?? DEFAULT_REFUEL_ETH;
  const { signal } = opts;

  if (recipientWalletId === treasuryWalletId) return { ok: false, error: "the treasury cannot refuel itself" };
  const amt = Number(amountEth);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: "amount must be a positive number" };
  let value: bigint;
  try { value = parseEther(amountEth); } catch { return { ok: false, error: `invalid ETH amount: ${amountEth}` }; }
  // A sub-wei amount (>18 dp) passes the Number()>0 guard but parseEther rounds it to 0n — refuse rather
  // than broadcast a 0-value tx that burns gas, moves nothing, and would log a false success.
  if (value <= 0n) return { ok: false, error: "amount rounds to zero wei" };
  // Spend cap: loud reject BEFORE taking the treasury nonce lane, so a capped refuel never
  // occupies the serial lane. Compared in wei against the parsed value.
  if (value > MAX_REFUEL_WEI) return { ok: false, error: `refuel ${amountEth} ETH exceeds cap ${MAX_REFUEL_ETH} (NEXT_PUBLIC_NADO_MAX_REFUEL_ETH)` };

  return serializeOnTreasury(treasuryWalletId, async (): Promise<FundingResult> => {
    try {
      const treasury = evmAddressForWalletId(treasuryWalletId);          // throws if the cohort is locked
      const recipient = evmAddressForWalletId(recipientWalletId).publicKey;

      // Solvency precheck up-front → a clear operator-facing error instead of an opaque broadcast
      // failure. A bare EOA→EOA send also costs ~21000 gas, so the treasury must hold MORE than `value`.
      const treasuryWei = await fetchNativeWei(treasury.publicKey, readSignal(signal));
      if (treasuryWei <= value) return { ok: false, error: "treasury is low on gas — fund the treasury wallet first" };

      const { Network, ChainClient } = await import("wative-core"); // lazy (heavy; matches depositLive)
      const inkNet = new Network(CHAIN_LABEL, CHAIN, INK_RPC, { name: "Ether", symbol: "ETH", decimals: 18 });
      const chain = new ChainClient(inkNet);

      // Native value transfer: no contract/calldata. Build for Ink explicitly (chainId + rpcUrl) so the
      // nonce + gas autofill and the sign target the Ink RPC regardless of the wallet's bound network.
      const tx = treasury.buildTransaction({ to: recipient, value, chainId: CHAIN as unknown as WativeChainId, rpcUrl: INK_RPC });
      await tx.sign();
      const raw = tx.rawTransaction;
      if (!raw) return { ok: false, error: "refuel did not produce signed bytes" };
      const hash = await chain.broadcast(raw);
      const r = await waitForReceipt(chain, hash, { signal });
      if (!r.mined) return { ok: false, tx: hash, status: "pending", error: `refuel confirmation timed out (${hash})` };
      if (r.success) {
        // Recipient gained gas, treasury spent it — drop both cached balances so the badges refresh on
        // the next reconcile instead of waiting out the 30s TTL (Wave 3a SWR hook).
        invalidateNativeBalance(recipientWalletId);
        invalidateNativeBalance(treasuryWalletId);
      }
      return { ok: r.success, tx: hash, status: r.success ? "success" : "reverted" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

/** MINT testnet USDT0 IN-TAB: the treasury calls USDT0.mint(recipient, amount) — the Ink-TESTNET USDT0
 *  is an openly-mintable faucet token (no minter role), so this is the testnet on-ramp (mainnet USDT0 is
 *  bridged — see docs/runbook/funding-onramp.md; M2). Built + signed by the sealed treasury signer,
 *  broadcast by a keyless ChainClient. Serialized on the treasury nonce (one EOA) like refuel. Amount is
 *  USDT0 6-decimals. TESTNET-ONLY: hard-gated to the Ink testnet chain — mint must never reach mainnet. */
export async function mintUsdt0Live(
  recipientWalletId: string,
  amount: string,
  opts: { treasuryWalletId?: string; signal?: AbortSignal } = {},
): Promise<FundingResult> {
  if (!IS_TESTNET) return { ok: false, error: "mint is testnet-only (the Ink-testnet USDT0 faucet)" };
  const treasuryWalletId = opts.treasuryWalletId ?? TREASURY_WALLET_ID;
  const { signal } = opts;

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: "amount must be a positive number" };
  let amt6: bigint;
  try { amt6 = parseUnits(amount, 6); } catch { return { ok: false, error: `invalid USDT0 amount: ${amount}` }; }
  if (amt6 <= 0n) return { ok: false, error: "amount rounds to zero" }; // a >6-dp input rounds to 0n

  return serializeOnTreasury(treasuryWalletId, async (): Promise<FundingResult> => {
    try {
      const treasury = evmAddressForWalletId(treasuryWalletId);          // throws if the cohort is locked
      const recipient = evmAddressForWalletId(recipientWalletId).publicKey;

      // Solvency precheck is GAS-only — mint sends value=0; the treasury pays only the call gas. (Do NOT
      // reuse refuel's value-based check: that compares an ETH-wei balance against a USDT0 6-dp amount.)
      const treasuryWei = await fetchNativeWei(treasury.publicKey, readSignal(signal));
      if (treasuryWei <= 0n) return { ok: false, error: "treasury is low on gas — fund the treasury wallet first" };

      const { Network, ChainClient, Contract } = await import("wative-core"); // lazy (heavy; matches depositLive)
      const inkNet = new Network(CHAIN_LABEL, CHAIN, INK_RPC, { name: "Ether", symbol: "ETH", decimals: 18 });
      const chain = new ChainClient(inkNet);
      const erc20 = new Contract("USDT0", ERC20_ABI as never);
      const buildOpts = { chainId: CHAIN as unknown as WativeChainId, rpcUrl: INK_RPC };

      const tx = erc20.call(treasury as unknown as WativeAddress, USDT0, "mint", [recipient, amt6], buildOpts);
      await tx.sign();
      const raw = tx.rawTransaction;
      if (!raw) return { ok: false, error: "mint did not produce signed bytes" };
      const hash = await chain.broadcast(raw);
      const r = await waitForReceipt(chain, hash, { signal });
      if (!r.mined) return { ok: false, tx: hash, status: "pending", error: `mint confirmation timed out (${hash})` };
      return { ok: r.success, tx: hash, status: r.success ? "success" : "reverted" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

/** Keyless ERC-20 balanceOf via a direct eth_call to the CORS-open Ink RPC (mirrors readAllowance) —
 *  used to SKIP a mint for a wallet that already holds enough USDT0 (idempotent bulk funding). */
async function readErc20Balance(owner: string, signal?: AbortSignal): Promise<bigint> {
  const { Contract } = await import("wative-core");
  const erc20 = new Contract("USDT0", ERC20_ABI as never) as unknown as { encode(fn: string, args: unknown[]): string; decode(fn: string, hex: string): readonly unknown[] };
  const data = erc20.encode("balanceOf", [owner]);
  const res = await fetch(INK_RPC, {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDT0, data }, "latest"] }),
  });
  const j = (await res.json()) as { result?: string; error?: { message?: string } };
  if (j.error) throw new Error(`balanceOf read failed: ${j.error.message ?? "rpc error"}`);
  if (!j.result || j.result === "0x") return 0n;
  const [val] = erc20.decode("balanceOf", j.result);
  return BigInt(String(val));
}

// The on-chain funding-bootstrap gas floor (wei) — a wallet below this can't run approve+deposit, so the
// bulk path refuels it first. Mirrors the fund-cohort GAS_EACH / readiness gasFloor (0.00003 ETH).
const FUNDING_GAS_FLOOR_WEI = parseEther("0.00003");

// Session-cumulative deposited USDT0 across cohort-funding runs. Monotonic for the page's
// lifetime (a reload resets it) — the safest "session ceiling"; deliberately NOT reset by
// resetLiveContexts(), so a lock/re-import cannot be used to top the budget back up.
let sessionDepositedUsdt0 = 0;

export interface FundProgress { walletId: string; phase: "gas" | "mint" | "deposit" | "done" | "skip"; status: "ok" | "failed"; tx?: string; error?: string }
export interface FundCohortOpts {
  treasuryWalletId?: string;
  gasEach?: string;      // native ETH top-up when a wallet is below the gas floor
  mintEach?: string;     // USDT0 minted when a wallet holds less than depositEach
  depositEach?: string;  // USDT0 deposited as collateral
  onProgress?: (p: FundProgress) => void;
  signal?: AbortSignal;  // kill switch — checked between wallets and threaded into each step
}
export interface FundCohortResult { funded: number; failed: number; skipped: number }

/** BULK cohort funding (TESTNET on-ramp) — productizes fund-cohort.mjs as an operator path. For each
 *  target wallet, SEQUENTIALLY: (1) refuel gas if below the floor, (2) mint USDT0 if it holds less than
 *  the deposit target, (3) approve+deposit the collateral (depositLive). Steps 1-2 run from the treasury
 *  and serialize on its nonce (inside refuel/mint); step 3 signs from the wallet itself. Idempotent by
 *  skip-check (gas floor + USDT0 balance), so a re-run only does the missing steps — but callers should
 *  target readiness==="unfunded" wallets because depositCollateral is NOT idempotent. Abortable. */
export async function fundCohortLive(walletIds: string[], opts: FundCohortOpts = {}): Promise<FundCohortResult> {
  const treasuryWalletId = opts.treasuryWalletId ?? TREASURY_WALLET_ID;
  const gasEach = opts.gasEach ?? DEFAULT_REFUEL_ETH;
  const mintEach = opts.mintEach ?? DEFAULT_MINT_USDT0;
  const depositEach = opts.depositEach ?? DEFAULT_DEPOSIT_USDT0;
  const { signal, onProgress } = opts;
  let depTarget: bigint;
  try { depTarget = parseUnits(depositEach, 6); } catch { depTarget = 0n; }

  // Fail-fast: reject the whole batch once if a per-wallet amount exceeds its cap, instead of
  // churning refuel+mint on every wallet only to fail each at the (capped) deposit. Thrown, so
  // the FundingPanel surfaces it; no wallet is touched.
  if (Number(depositEach) > MAX_DEPOSIT_USDT0) throw new Error(`deposit ${depositEach} USDT0/wallet exceeds cap ${MAX_DEPOSIT_USDT0} (NEXT_PUBLIC_NADO_MAX_DEPOSIT_USDT0)`);
  if (Number(gasEach) > MAX_REFUEL_ETH) throw new Error(`gas ${gasEach} ETH/wallet exceeds cap ${MAX_REFUEL_ETH} (NEXT_PUBLIC_NADO_MAX_REFUEL_ETH)`);

  let funded = 0, failed = 0, skipped = 0;
  for (const walletId of walletIds) {
    if (signal?.aborted) break;
    if (walletId === treasuryWalletId) { skipped++; onProgress?.({ walletId, phase: "skip", status: "ok" }); continue; } // never fund the gas source itself
    // Session cohort-wide USDT0 ceiling — stop BEFORE the next deposit would breach it. Thrown
    // OUTSIDE the per-wallet try below so it halts the whole run (not swallowed as one wallet's
    // failure); wallets already funded this session stay recorded via onProgress on the panel.
    if (sessionDepositedUsdt0 + Number(depositEach) > MAX_COHORT_USDT0) {
      throw new Error(`cohort deposit cap ${MAX_COHORT_USDT0} USDT0 reached after funding ${funded} wallet(s) this session (NEXT_PUBLIC_NADO_MAX_COHORT_USDT0)`);
    }
    try {
      const owner = evmAddressForWalletId(walletId).publicKey; // throws if the cohort is locked
      // 1 — gas: refuel only if below the bootstrap floor (an unfunded wallet is also gasless).
      const nativeWei = await fetchNativeWei(owner, readSignal(signal)).catch(() => 0n);
      if (nativeWei < FUNDING_GAS_FLOOR_WEI) {
        const g = await refuelGasLive(walletId, { amountEth: gasEach, treasuryWalletId, signal });
        onProgress?.({ walletId, phase: "gas", status: g.ok ? "ok" : "failed", tx: g.tx, error: g.error });
        if (!g.ok) { failed++; continue; }
      }
      // 2 — mint: only if the wallet holds less USDT0 than the deposit target (skip = idempotent re-run).
      const bal = await readErc20Balance(owner, readSignal(signal)).catch(() => 0n);
      if (bal < depTarget) {
        const m = await mintUsdt0Live(walletId, mintEach, { treasuryWalletId, signal });
        onProgress?.({ walletId, phase: "mint", status: m.ok ? "ok" : "failed", tx: m.tx, error: m.error });
        if (!m.ok) { failed++; continue; }
      }
      // 3 — approve + deposit collateral (depositLive), signed by the wallet itself.
      const d = await depositLive(walletId, depositEach, signal);
      onProgress?.({ walletId, phase: "deposit", status: d.ok ? "ok" : "failed", tx: d.tx, error: d.error });
      if (!d.ok) { failed++; continue; }
      funded++;
      sessionDepositedUsdt0 += Number(depositEach); // count only executed deposits toward the session ceiling
      onProgress?.({ walletId, phase: "done", status: "ok" });
    } catch (e) {
      failed++;
      onProgress?.({ walletId, phase: "done", status: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { funded, failed, skipped };
}

/** WITHDRAW collateral IN-TAB: build the Nado `withdraw_collateral` EIP-712 with a
 *  sequential tx nonce (fetched through the keyless relay), sign IN-TAB, inject the
 *  signature into the SDK payload builder (no walletClient), and POST the signed payload
 *  to the keyless relay. The server neither signs nor holds a key. */
export async function withdrawLive(walletId: string, amount: string, signal?: AbortSignal): Promise<FundingResult> {
  const { live, cfg } = await liveFor(walletId);
  const endpoint = cfg.endpoint;
  if (!endpoint) return { ok: false, error: "no live endpoint configured" };
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: "amount must be a positive number" };

  try {
    const signer = signerForWalletId(walletId);
    const owner = signer.address.value;
    const amt6 = parseUnits(amount, 6).toString();
    // Sequential TX nonce (through the keyless relay /query) — we sign over it, so we
    // must control it rather than let the builder compute one.
    const nonce = String(await live.engine.getTxNonce(owner));
    const built = buildWithdrawTypedData(amt6, {
      ownerAddress: owner, subaccountName: SUBACCT, chainId: CHAIN, endpoint, productId: QUOTE_PRODUCT, nonce,
    });
    const signature = await signer.signTypedData!(built.typedData, CHAIN);
    // Inject the in-tab signature → no walletClient needed; byte-identical to the signed
    // message because the builder re-runs getNadoEIP712Values on the same `withdraw`.
    const payload = await live.engine.payloadBuilder.buildWithdrawCollateralPayload({ ...built.withdraw, signature } as never);
    const res = await fetch(`${RELAY}/execute`, {
      method: "POST", headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify({ withdraw_collateral: payload }),
    });
    const data = (await res.json()) as { status?: string; error?: string; error_code?: number | string };
    if (!res.ok && !data.status) return { ok: false, error: `HTTP ${res.status}` };
    if (data.status && data.status !== "success") {
      return { ok: false, status: data.status, error: `sequencer ${data.error_code ?? ""}: ${data.error ?? "rejected"}`.trim() };
    }
    return { ok: data.status === "success", status: data.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
