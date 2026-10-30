// =============================================================================
// @farm/loadgen · experiment-connector — the base-native ExperimentConnector that wires
// @farm/core's engine (the A/B coordinator's seam + the OrderLedger no-double-place kernel)
// to @farm/adapter-nado's Nado primitives. This is the SKELETON: fully assembled and
// unit-tested against a FAKE gateway (no funds, no live network). The LIVE wiring — the real
// Nado read API for the authoritative per-order taker fill (A-5), and confirming the
// dispatch classification code table against the live sequencer — is the operator/testnet
// step (see docs/phasea-testnet-validation.md); those are injected here as seams.
//
// Flow (matches the intern's proven path, minus its 801-line console specifics):
//   prepare  → resolve a RETRY-STABLE identity (OrderIdentityCache: price+size+nonce+expiration
//              fixed once per request.id) → buildPlaceOrderTypedData → sign (custody) → payload.
//   dispatch → OrderLedger.submit (admit guard bridges to the campaign; per-wallet no-double-
//              place) → its ProtectedOrderConnector relays via gateway.submitOrder, classifying
//              failures with classifyDispatch (not-sent → no halt; unknown → halt; deduped → placed).
//   lookup   → resting via open orders + the injected per-order fill source (A-5 reconciliation).
//   cancel   → buildCancelTypedData → sign → gateway.cancelOrders.
//   preflight→ positions + open orders → pair snapshot. fillHints = true (public fill stream).
// =============================================================================
import {
  OrderLedger, KnownOrderNotSent, KnownOrderRejection, knownOrderNotSentReason,
  ExperimentUnsentOrderError, pairProductId,
  type ProtectedOrderConnector, type OrderEvidence, type ProtectedOrder,
  type OperationsStore, type OrderAdmission,
  type ExperimentConnector, type ExperimentCampaign, type ExperimentPair, type ExperimentOrder,
  type ExperimentOrderRequest, type PreparedExperimentOrder, type ExperimentOrderFact,
  type ExperimentPairSnapshot, type ExperimentRollover, type ExperimentRolloverFact,
} from "@farm/core";
import { buildPlaceOrderTypedData, buildCancelTypedData, clampOrderSize, type NadoGateway, type NadoMarketSizing, type BuiltOrder } from "@farm/adapter-nado";
import type { WalletSigner, PlaceOrderInput, Hex } from "@farm/adapter-api";
import { hashTypedData, formatUnits } from "viem";
import { classifyDispatch, type DispatchErrorInfo } from "./classify.js";
import { OrderIdentityCache } from "./order-identity.js";

const DEFAULT_TTL_SECS = 7 * 24 * 60 * 60;
// Placeholder flat-baseline equity (x18) used ONLY when no live `equityFor` source is injected
// (the no-sizing / no-maxLoss offline+benchmark path, where risk accounting must stay inert
// without blocking new risk — `null` would block it). A real-funds run injects `equityFor`
// (getBalances → sum USDT0 collateral; see createLiveEquitySource) so the per-wallet maxLoss the
// coordinator already models (recordStats) sees a real, moving equity instead of this constant.
const PLACEHOLDER_EQUITY_X18 = "100000000000000000000000";

/** The authoritative per-order fill, resolved from the LIVE Nado read path at the testnet
 *  gate (the keyless public `fill` stream or an order-by-digest query). Returns undefined if
 *  the order is not yet known to the exchange. `terminal` is proven by position reconciliation
 *  (A-5), never by a missing cancel row. Faked in offline tests. */
export interface OrderFillSource {
  (owner: string, productId: number, digest: string): Promise<
    { filledX18: string; quoteFilledX18: string; feePaidX18: string; terminal: boolean; resting: boolean } | undefined
  >;
}

/** Real per-wallet account equity (x18 signed integer string), resolved from the LIVE account
 *  read (getBalances → sum of the wallet's USDT0 collateral, marked to market). Injected at the
 *  real-funds gate; left unset on the pure offline/benchmark path (then a flat placeholder keeps
 *  the coordinator's risk accounting inert). A `null` result means equity is not observable right
 *  now → the coordinator blocks NEW risk and keeps the flat baseline (ExperimentWalletSnapshot
 *  contract), never a silent zero. Keeping this injectable is what lets the offline fakes run
 *  unchanged while the live path enforces the real per-wallet maxLoss. */
export interface EquitySource {
  (owner: string): Promise<string | null>;
}

/** Normalises a raw gateway/transport error into the classifier's view. The raw→this mapping
 *  is the one part verified against live Nado responses at the testnet gate; the classifier
 *  itself is pure policy. Default best-effort over common shapes. */
export type DispatchErrorNormaliser = (error: unknown) => DispatchErrorInfo;

export interface NadoExperimentConnectorDeps {
  chainId: number;
  /** The Nado Endpoint address (cancel domain's verifyingContract). */
  endpoint: string;
  /** Per-wallet gateway view over one shared transport+limiter (single-IP budget). */
  forOwner(owner: string): NadoGateway;
  /** Custody signer for a wallet (signs the EIP-712 typed data in-tab/keyless-server). */
  signerFor(owner: string): WalletSigner;
  /** Per-product sizing (tick/step/min/min-notional) from getSymbols; see adapter-nado/sizing. */
  sizingFor(productId: number): NadoMarketSizing;
  /** Monotonic, clock-corrected time source (ClockSync) for nonce/expiration. */
  clock: () => number;
  /** A MarketId for a productId (buildPlaceOrderTypedData ignores it, but PlaceOrderInput needs one). */
  marketIdFor(productId: number): string;
  /** LIVE per-order fill source (A-5). Injected at the testnet gate; faked in tests. */
  orderFill: OrderFillSource;
  /** LIVE per-wallet equity source (getBalances → USDT0 collateral). Injected for a real-funds
   *  run so the per-wallet maxLoss cap is enforced on real equity; unset offline (the placeholder
   *  equity keeps risk accounting inert). See EquitySource. */
  equityFor?: EquitySource;
  /** The experiment order-admission guard (experiment/guards.assertExperimentOrderAdmission). */
  admit: OrderAdmission<ExperimentCampaign>;
  /** The desk store the ledger persists through (shared with the coordinator). */
  store: OperationsStore<ExperimentCampaign>;
  /** Raw→DispatchErrorInfo (testnet-verified). Defaults to a best-effort normaliser. */
  normaliseError?: DispatchErrorNormaliser;
  /** Post-only maker depth: how many ticks of HEADROOM to leave from the OPPOSITE touch, so the
   *  resting maker survives the book tightening a tick or two between the book-read and submit
   *  (else post-only-would-cross, sequencer 2008). The maker is still clamped to improve its NEAR
   *  touch (>= near±tick), so it is alone at the top and the self-cross taker crosses IT, not
   *  resting external liquidity — this needs a spread wider than the headroom (the runner selects
   *  one). Defaults to 1 (the legacy best±1-tick placement). */
  makerHeadroomTicks?: number;
  /** MVP touch-fallback: when the spread is too tight to improve into a fresh empty tick, post A's
   *  maker AT the near touch (join) so it still RESTS and B can take it — instead of refusing
   *  (EXPERIMENT_NO_EMPTY_TICK). A may share the touch queue (occasional stray, flattened in
   *  wind-down). OFF by default → mainnet keeps the strict clean-self-cross guarantee. */
  touchFallback?: boolean;
}

/** Best-effort raw→DispatchErrorInfo. The exact Nado error shape is confirmed at the testnet
 *  gate; until then this reads the common fields defensively and defaults ambiguous to `unknown`. */
export const defaultNormaliseError: DispatchErrorNormaliser = (error) => {
  const e = (error ?? {}) as Record<string, unknown>;
  // The adapter throws two concrete shapes (testnet-gate confirmed): a sequencer-refusal
  // AdapterError from assertOk ({category:"rejected", raw:{status:"failure", error_code}}) and
  // a transport httpError ({code:String(status), raw:{status:<number>}}). raw is null for
  // non-envelope errors, so access it null-safely.
  const raw = (e.raw && typeof e.raw === "object") ? (e.raw as Record<string, unknown>) : {};
  const message = typeof e.message === "string" ? e.message : String(error ?? "");
  const category = typeof e.category === "string" ? e.category : undefined;
  // A post-send-capable transport/relay failure ("network" / "retryable-unsafe") must NOT have
  // a code mined from its free text — a "code: 2013" inside a relay's 502 body would fabricate
  // a phantom deduped (=placed), a double-place-adjacent mislabel (normaliser pre-audit H2).
  const trustText = category !== "network" && category !== "retryable-unsafe";

  // ---- sequencer ENGINE code. STRUCTURED fields first (raw.error_code is the envelope's
  //      dedicated code; a stringified number there is fine — NOT free-text mining), then a
  //      code-TAGGED token in the message. NEVER a bare number from free text (false 2013 →
  //      phantom placement). A numeric string `code` of 4+ digits is a venue code; a 3-digit
  //      one is an HTTP status (handled below), never a sequencer code (H3).
  const codeStr = typeof e.code === "string" && /^\d+$/.test(e.code) ? Number(e.code) : undefined;
  const rawErrCode = Number((raw as { error_code?: unknown }).error_code);
  const nadoCode =
    typeof e.nadoCode === "number" ? e.nadoCode
    : (raw as { error_code?: unknown }).error_code != null && Number.isFinite(rawErrCode) ? rawErrCode // H4
    : typeof e.code === "number" ? e.code                                             // G1 (keep: excludes string "429"/"403")
    : codeStr !== undefined && codeStr >= 1000 ? codeStr                              // H3: 4-digit string → venue code
    : trustText ? (() => { const m = /\b(?:code|error_code|reason)[\s:="']*(\d{3,4})\b/i.exec(message); return m ? Number(m[1]) : undefined; })()
    : undefined;

  // ---- HTTP status. NUMERIC fields only: the sequencer envelope's raw.status is the STRING
  //      "success"/"failure" and must not leak in as a status (H1); only transport's raw.status
  //      is the HTTP number. A 3-digit numeric string `code` is a transport status.
  const rawStatus = typeof (raw as { status?: unknown }).status === "number" ? (raw as { status: number }).status : undefined;
  const httpStatus =
    typeof e.httpStatus === "number" ? e.httpStatus
    : typeof e.status === "number" ? e.status
    : rawStatus !== undefined ? rawStatus
    : codeStr !== undefined && codeStr < 1000 ? codeStr                               // H3: 3-digit string → HTTP status
    : undefined;

  // Any edge 403 on this keyless public write is a request REJECTED before origin (Cloudflare
  // WAF compression block, or an IP-level block) → the order never reached the book → not-sent.
  // Sequencer admissibility refusals are HTTP-200 + {status:"failure", error_code}, never a 403
  // (confirm at the testnet gate — docs/phasea-testnet-validation.md §1).
  const wafCompressionBlock = e.wafCompressionBlock === true || httpStatus === 403;

  // transportAborted = PROVABLY pre-send ONLY. ECONNRESET / ETIMEDOUT / EPIPE and a bare
  // AbortError are post-send-capable (the order MAY have reached the book) → they must stay
  // UNKNOWN, never not-sent (marking a maybe-placed order ABORTED_UNSENT is a lost-fill /
  // double-place risk). Only a connect-level failure (or an explicit pre-send marker from the
  // live wiring) qualifies — and never when a structured code / http status is present (the
  // request reached the sequencer or the edge).
  const preSend = e.transportAborted === true || /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/.test(message);
  const transportAborted = preSend && nadoCode === undefined && httpStatus === undefined;
  return { nadoCode, httpStatus, transportAborted, wafCompressionBlock, message };
};

export class NadoExperimentConnector implements ExperimentConnector {
  private readonly identities = new OrderIdentityCache();
  private readonly allowedByOrderId = new Map<string, () => boolean>();
  readonly ledger: OrderLedger<ExperimentCampaign>;

  constructor(private readonly deps: NadoExperimentConnectorDeps) {
    const normalise = deps.normaliseError ?? defaultNormaliseError;
    const relay: ProtectedOrderConnector = {
      dispatch: (row, ledgerAllowed) => this.relay(row, ledgerAllowed, normalise),
      lookup: (row) => this.evidence(row),
    };
    this.ledger = new OrderLedger<ExperimentCampaign>(deps.store, relay, deps.chainId, deps.admit);
  }

  // ---- ExperimentConnector seam -----------------------------------------------------------
  async preflight(_c: ExperimentCampaign, pair: ExperimentPair): Promise<ExperimentPairSnapshot> {
    const [a, b] = await Promise.all([this.walletSnapshot(pair.a), this.walletSnapshot(pair.b)]);
    return { complete: true, observedAt: this.deps.clock(), a, b };
  }

  async prepare(c: ExperimentCampaign, pair: ExperimentPair, request: ExperimentOrderRequest): Promise<PreparedExperimentOrder> {
    // Single-source chainId: the EIP-712 domain is built with c.chainId but the signature is
    // produced against deps.chainId (sign()); a divergence yields a valid-looking signature over
    // the WRONG chain → silent rejection. Fail loud + unsent here (composition pre-audit #4).
    if (c.chainId !== this.deps.chainId) throw new ExperimentUnsentOrderError("EXPERIMENT_CHAINID_MISMATCH");
    const productId = pairProductId(c, pair);
    const sizing = this.deps.sizingFor(productId);
    const gw = this.deps.forOwner(request.owner);
    // RETRY-STABLE identity: read the book + size ONCE per request.id; a retry reuses it so the
    // rebuilt order is byte-identical (same digest → sequencer dedups, no double place).
    let identity = this.identities.peek(request.id);
    if (!identity) {
      const book = await gw.getOrderBook(this.deps.marketIdFor(productId));
      const bestBid = book.bids[0]?.price, bestAsk = book.asks[0]?.price;
      const postOnly = request.postOnly;
      // maker rests inside the spread; taker crosses the current best (which already includes a
      // just-posted self-cross maker) with the slippage bound. On a thin book the maker price is
      // the reference — deterministic-cross tuning is confirmed at the testnet gate.
      const ref = Number(bestBid ?? bestAsk ?? "0") || Number(request.notionalX18 ? "0" : "0");
      const tick = Number(sizing.tickSize) || 0;
      const tickDec = (sizing.tickSize.split(".")[1] || "").length; // tick's decimal places
      const slip = (request.slippageBps ?? c.slippageBps) / 10_000;
      // Headroom clamp ≥ 1 (0 would price the maker AT the opposite touch → it crosses).
      const headroom = Math.max(1, Math.floor(this.deps.makerHeadroomTicks ?? 1));
      let price: number;
      let hardLimit = false;
      if (postOnly && request.role === "A_OPEN") {
        // §2 mechanism: A posts at a FRESH, strictly-better tick EMPTY of external orders (sole
        // order at its price), never joining an occupied touch. Candidates are the ticks strictly
        // INSIDE the spread (between the touches); the preferred one is `headroom` ticks off the
        // opposite touch (so it survives a small tighten) but still ≥ 1 tick better than the near
        // touch. If the spread has no strictly-inside tick (too tight — the book collapsed since
        // selection), or every candidate is occupied by an external order, SKIP the round
        // (EXPERIMENT_NO_EMPTY_TICK → the coordinator sets it aside flat) rather than rest into an
        // occupied level where B could cross a stranger.
        const bb = Number(bestBid ?? "0"), ba = Number(bestAsk ?? "0");
        if (!(bb > 0 && ba > 0 && tick > 0)) throw new ExperimentUnsentOrderError("EXPERIMENT_BOOK_INVALID");
        const bbIdx = Math.round(bb / tick), baIdx = Math.round(ba / tick);
        const occupied = new Set<number>([...book.bids, ...book.asks].map((l) => Math.round(Number(l.price) / tick)));
        const pref = Math.min(baIdx - 1, Math.max(bbIdx + 1, request.side === "BUY" ? baIdx - headroom : bbIdx + headroom));
        const inside = (i: number) => i > bbIdx && i < baIdx;
        let chosen: number | undefined;
        if (baIdx - bbIdx >= 2) {                               // ≥1 strictly-inside tick exists → clean self-cross
          for (let d = 0; d <= baIdx - bbIdx; d++) {
            if (inside(pref - d) && !occupied.has(pref - d)) { chosen = pref - d; break; }         // prefer toward the near touch (safer on a tighten)
            if (d > 0 && inside(pref + d) && !occupied.has(pref + d)) { chosen = pref + d; break; } // then deeper (more headroom)
          }
        }
        if (chosen === undefined) {
          // No fresh empty tick (spread too tight, or every inside tick occupied). MVP touch-fallback:
          // join the NEAR touch (BUY→best bid, SELL→best ask) so A's post-only maker still RESTS and B
          // can take it — A may share the touch queue (occasional stray, flattened in wind-down).
          // Without touchFallback this stays a hard refusal, so mainnet keeps the clean guarantee.
          if (this.deps.touchFallback) chosen = request.side === "BUY" ? bbIdx : baIdx;
          else throw new ExperimentUnsentOrderError("EXPERIMENT_NO_EMPTY_TICK");
        }
        price = chosen * tick;
      } else if (postOnly) {
        // B's reduce-only CLOSE maker rests `headroom` ticks inside the opposite touch, clamped to
        // still improve its near touch — the close mirrors the open (A's taker crosses it).
        const bb = Number(bestBid ?? bestAsk ?? ref), ba = Number(bestAsk ?? bestBid ?? ref);
        price = request.side === "BUY"
          ? Math.min(ba - tick, Math.max(bb + tick, ba - headroom * tick))
          : Math.max(bb + tick, Math.min(ba - tick, bb + headroom * tick));
      } else if (request.limitPriceX18 !== undefined) {
        // §2 mechanism: the self-cross taker (B's open) is HARD-limited to EXACTLY A's resting
        // price — it crosses only A (the sole order at that price) and cannot sweep past A into
        // external liquidity. Used verbatim (A's price is already grid-aligned); no slippage, no
        // re-snap (which could round the limit past A's price and re-open the sweep).
        price = Number(formatUnits(BigInt(request.limitPriceX18), 18));
        hardLimit = true;
      } else price = request.side === "BUY" ? Number(bestAsk ?? ref) * (1 + slip) : Number(bestBid ?? ref) * (1 - slip);
      if (!(price > 0)) throw new ExperimentUnsentOrderError("EXPERIMENT_BOOK_INVALID");
      // Snap to the tick grid, rounding so a TAKER stays aggressive enough to cross (BUY ceil /
      // SELL floor) and a MAKER stays passive, away from crossing (BUY floor / SELL ceil); then
      // format to the tick's decimals, else the sequencer rejects 2000 "price not divisible by
      // the price_increment" (the slip multiplier on a taker price lands off-grid). The maker
      // offset is already grid-aligned, so its snap is a float-safety no-op. The hard-limit taker
      // is NOT re-snapped — A's price is already on-grid and rounding it up would let B sweep past.
      if (tick > 0 && !hardLimit) { const up = (request.side === "BUY") !== postOnly; const ticks = up ? Math.ceil(price / tick) : Math.floor(price / tick); price = ticks * tick; }
      if (!(price > 0)) throw new ExperimentUnsentOrderError("EXPERIMENT_BOOK_INVALID"); // a tiny-price snap to 0 escapes the pre-snap guard
      const priceStr = tick > 0 ? price.toFixed(tickDec) : String(price);
      // size: an explicit base qty (a follow/close) stays; else notional → base at this price.
      const baseSize = request.quantityX18 !== undefined ? formatUnits(BigInt(request.quantityX18), 18)
        : String(Number(formatUnits(BigInt(request.notionalX18 ?? c.orderNotionalX18), 18)) / price);
      const size = clampOrderSize(baseSize, { stepSize: sizing.stepSize, minSize: sizing.minSize, price: priceStr, minNotional: sizing.minNotional });
      const nonce = this.mintNonce();
      const expiration = Math.floor(this.deps.clock() / 1000) + DEFAULT_TTL_SECS;
      identity = this.identities.resolve(request.id, () => ({ nonce, expiration, price: priceStr, size }));
    }
    const input: PlaceOrderInput = {
      market: this.deps.marketIdFor(productId), side: request.side === "BUY" ? "buy" : "sell",
      kind: request.postOnly ? "limit" : "market", size: identity.size as PlaceOrderInput["size"],
      price: identity.price as PlaceOrderInput["price"], tif: request.postOnly ? "gtc" : "ioc",
      postOnly: request.postOnly, reduceOnly: request.reduceOnly, clientId: request.id,
      ...(c.selfCross ? { selfTradePrevention: "none" as const } : {}),
    };
    const built = buildPlaceOrderTypedData(input, {
      chainId: c.chainId, productId, ownerAddress: request.owner, subaccountName: "default",
      nonce: BigInt(identity.nonce), expiration: BigInt(identity.expiration),
    });
    const signature = await this.sign(request.owner, built);
    const digest = hashTypedData(built.typedData as never);
    return {
      id: request.id, mode: c.mode, chainId: c.chainId, owner: request.owner, productId,
      digest, payload: JSON.stringify({ order: built.order, sender: built.sender, signature }),
      quantityX18: String(built.amount < 0n ? -built.amount : built.amount), priceX18: String(built.priceX18),
      nonce: identity.nonce, expiration: identity.expiration, side: request.side,
      reduceOnly: request.reduceOnly, postOnly: request.postOnly,
    };
  }

  async dispatch(_c: ExperimentCampaign, prepared: PreparedExperimentOrder, allowed: () => boolean): Promise<string> {
    if (!allowed()) throw new ExperimentUnsentOrderError("STOPPED_BEFORE_DISPATCH");
    const id = `${this.deps.chainId}:${prepared.id}`;
    this.allowedByOrderId.set(id, allowed); // let the relay honour a mid-dispatch stop
    try {
      const row = await this.ledger.submit({
        id, owner: prepared.owner, chainId: this.deps.chainId, productId: prepared.productId,
        digest: prepared.digest, payload: prepared.payload, quantityX18: prepared.quantityX18,
        side: prepared.side, priceX18: prepared.priceX18, nonce: prepared.nonce, expiration: prepared.expiration,
      });
      if (row.state === "ACKED") return row.digest;
      const notSent = knownOrderNotSentReason(row);
      if (notSent) throw new ExperimentUnsentOrderError(notSent); // provably never sent → ABORTED_UNSENT
      if (row.state === "REJECTED") throw new Error(row.errorCode ?? "ORDER_REJECTED_0"); // ORDER_REFUSED_/ORDER_REJECTED_
      throw new Error(row.errorCode ?? "ORDER_RESULT_UNKNOWN"); // UNKNOWN → coordinator UNKNOWN
    } finally {
      this.allowedByOrderId.delete(id);
    }
  }

  async lookup(_c: ExperimentCampaign, order: ExperimentOrder): Promise<ExperimentOrderFact> {
    const observedAt = this.deps.clock();
    const fill = await this.deps.orderFill(order.owner, order.productId, order.digest);
    // A looked-up order is one WE dispatched, keyed by its own digest, so identity always
    // matches. `undefined` means the fill is not observable YET (pre-subscription / pre-index
    // lag) — report identityMatches:true, known:false so the coordinator's `lagging()` window
    // waits it out, rather than identityMatches:false which trips an immediate LOOKUP_UNKNOWN
    // pause (A-5 pre-audit #5). A genuine never-observed order still pauses once the lag window
    // elapses — safe, and never a double-place.
    if (!fill) return { digest: order.digest, identityMatches: true, known: false, terminal: false, filledX18: "0", quoteFilledX18: null, feePaidX18: null, observedAt };
    return {
      digest: order.digest, identityMatches: true, known: true, terminal: fill.terminal,
      filledX18: fill.filledX18, quoteFilledX18: fill.quoteFilledX18, feePaidX18: fill.feePaidX18, observedAt,
      ...(fill.resting && !fill.terminal ? { resting: true as const } : {}),
    };
  }

  async cancel(_c: ExperimentCampaign, order: ExperimentOrder, allowed: () => boolean): Promise<ExperimentOrderFact> {
    const observedAt = this.deps.clock();
    if (allowed()) {
      const gw = this.deps.forOwner(order.owner);
      const built = buildCancelTypedData({ venueIds: [order.digest] }, { chainId: this.deps.chainId, ownerAddress: order.owner, subaccountName: "default", verifyingContract: this.deps.endpoint }, [order.productId]);
      const signature = await this.sign(order.owner, built as unknown as BuiltOrder);
      try { await gw.cancelOrders({ ...built, signature }); } catch { /* fall through to a fresh fill read */ }
    }
    // Terminality is PROVEN by the fill source (position reconciliation), not by the cancel ack.
    const fill = await this.deps.orderFill(order.owner, order.productId, order.digest);
    return {
      digest: order.digest, identityMatches: true, known: !!fill, terminal: fill ? fill.terminal : false,
      filledX18: fill?.filledX18 ?? order.filledX18, quoteFilledX18: fill?.quoteFilledX18 ?? order.quoteFilledX18,
      feePaidX18: fill?.feePaidX18 ?? order.feePaidX18, observedAt,
    };
  }

  livePositions(_c: ExperimentCampaign): boolean { return true; }
  fillHints(_c: ExperimentCampaign): boolean { return true; } // woken off the public fill stream

  // Rollover is deferred (funding — Phase C); single-group benchmark never drives it.
  async rollover(): Promise<ExperimentRolloverFact> { throw new Error("EXPERIMENT_ROLLOVER_UNSUPPORTED"); }
  async lookupRollover(_c: ExperimentCampaign, step: ExperimentRollover): Promise<ExperimentRolloverFact> {
    return { id: step.id, identityMatches: true, state: "UNKNOWN", notStarted: true };
  }

  // ---- internals --------------------------------------------------------------------------
  private async relay(row: ProtectedOrder, ledgerAllowed: () => boolean, normalise: DispatchErrorNormaliser): Promise<string> {
    const coordAllowed = this.allowedByOrderId.get(row.id);
    if (!ledgerAllowed() || (coordAllowed && !coordAllowed())) throw new KnownOrderNotSent("STOPPED_BEFORE_SEND");
    const { order, sender, signature } = JSON.parse(row.payload) as { order: unknown; sender: string; signature: Hex };
    const gw = this.deps.forOwner(row.owner);
    try {
      // submitOrder only reads productId/order/signature/sender; the rest of BuiltOrder is unused.
      const res = await gw.submitOrder({ productId: row.productId, order, sender, signature } as unknown as BuiltOrder & { signature: Hex });
      return res.digest;
    } catch (error) {
      const verdict = classifyDispatch(normalise(error));
      if (verdict.kind === "deduped") return row.digest; // identical retry already placed (2013)
      if (verdict.kind === "not-sent") throw new KnownOrderNotSent(verdict.code);
      if (verdict.kind === "refused") throw new KnownOrderRejection(Number(verdict.code) || 0, false);
      if (verdict.kind === "rejected-fatal") throw new KnownOrderRejection(Number(verdict.code) || 0, true);
      throw error instanceof Error ? error : new Error(verdict.code); // unknown → ledger UNKNOWN (maybe placed)
    }
  }

  private async evidence(row: ProtectedOrder): Promise<OrderEvidence> {
    const fill = await this.deps.orderFill(row.owner, row.productId, row.digest);
    return {
      digest: row.digest, owner: row.owner, productId: row.productId, quantityX18: row.quantityX18,
      filledX18: fill?.filledX18 ?? "0", known: !!fill,
    };
  }

  private async walletSnapshot(owner: string) {
    const gw = this.deps.forOwner(owner);
    const [positions, openOrders] = await Promise.all([gw.getPositions("default"), gw.getOpenOrders("default")]);
    const net = positions.reduce((n, pos) => n + (pos.side === "short" ? -1n : 1n) * toX18(pos.size), 0n);
    // Real per-wallet equity from the injected live source (getBalances → sum USDT0 collateral);
    // its `null` means equity-not-observable (the coordinator then blocks new risk and keeps the
    // flat baseline). With NO source injected (pure offline / no-maxLoss benchmark) the non-null
    // placeholder keeps risk accounting inert without blocking new risk. This is the one place the
    // self-cross path ignored real risk; `equityFor` closes it while keeping the offline fakes pure.
    const equityX18 = this.deps.equityFor ? await this.deps.equityFor(owner) : PLACEHOLDER_EQUITY_X18;
    return { owner, positionX18: String(net), openDigests: openOrders.map((o) => o.venueId ?? "").filter(Boolean), equityX18 };
  }

  private mintNonce(): string {
    // recvTime-encoded nonce (nado-order-dedup-semantics): (recvTime_ms << 20) | random, recvTime
    // = now + 90s. Minted ONCE per order id (memoised) — never regenerated on retry.
    const recvTime = BigInt(this.deps.clock() + 90_000);
    const rand = BigInt(Math.floor(Math.random() * 1000));
    return ((recvTime << 20n) | rand).toString();
  }

  private async sign(owner: string, built: { typedData: unknown }): Promise<Hex> {
    const signer = this.deps.signerFor(owner);
    if (!signer.signTypedData) throw new Error("EXPERIMENT_SIGNER_NO_TYPED_DATA");
    return signer.signTypedData(built.typedData as never, this.deps.chainId);
  }
}

function toX18(human: string): bigint {
  const neg = human.startsWith("-");
  const [i, f = ""] = (neg ? human.slice(1) : human).split(".");
  const raw = BigInt(((i || "0") + f.padEnd(18, "0").slice(0, 18)).replace(/^0+(?=\d)/, ""));
  return neg ? -raw : raw;
}
