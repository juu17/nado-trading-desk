// =============================================================================
// @farm/adapter-nado · the LIVE NadoGateway — the concrete off-chain sequencer
// client, SERVER-SIDE only (it holds no key; the seam signs upstream).
//
// Writes (submit/cancel) are POSTed through core/MeteredTransport (rate-limited,
// metered) to `${engineUrl}/execute`, using the Nado SDK's SYNC payload builders
// to shape the exact server envelope from the seam-produced signature — so the
// signed message and the submitted payload are byte-identical by construction
// (the builder re-runs getNadoEIP712Values on the same `order`). Wire shapes were
// captured empirically (2026-10-16).
//
// Reads go through the SDK query client, each gated on the SAME RateLimiter, so
// every sequencer call is metered. getMarkets is served from the injected static
// market list; getOpenOrders is fully mapped (the verification read); balances are
// mapped defensively; positions/fills/orderbook are lean follow-ups (WS-backed).
//
// Single funded wallet for now: `owner` is injected, so read methods (which take
// only a subaccount LABEL at the seam) can form the owner+name the sequencer needs.
// =============================================================================
import { formatUnits, toHex } from "viem";
import { getOrderVerifyingAddress } from "@nadohq/client";
import type { EngineClient } from "@nadohq/engine-client";
import type {
  Market, MarketId, OrderBook, Order, Position, Fill, Balance, Hex, Decimal, AdapterError, RateScope,
} from "@farm/adapter-api";
import type { NadoGateway, SubmitOrderResult, CancelResult } from "./gateway.js";
import type { BuiltOrder, BuiltCancel } from "./execute.js";

// Structural contracts for core/MeteredTransport + core/RateLimiter — injected by
// the composition root. Keeping them structural means the adapter depends on
// @farm/adapter-api only (no adapter→core layering inversion); the real core types
// satisfy these shapes exactly.
interface MeteredRequestLike {
  bucket: string; scope: RateScope; weight: number; key?: string;
  method: "GET" | "POST"; url: string; body?: unknown; signal?: AbortSignal;
}
export interface TransportLike { request<T>(a: MeteredRequestLike): Promise<T> }
export interface LimiterLike { acquire(bucket: string, weight?: number, key?: string, signal?: AbortSignal): Promise<void> }

export interface LiveNadoGatewayDeps {
  engine: EngineClient;                      // SDK payload builder + query reads
  transport: TransportLike;                  // metered /execute POST (writes)
  limiter: LimiterLike;                       // gates reads too (every call metered)
  engineUrl: string;                          // sequencer base, e.g. …/gateway/v1
  chainId: number;
  endpoint: string;                           // Nado Endpoint addr (cancel domain)
  owner: string;                              // the funded wallet (single-wallet live)
  markets: readonly Market[];                 // static market list (getMarkets)
  productIds: Readonly<Record<MarketId, number>>;
}

// The minimal slice of the SDK's mapped EngineOrder we read (BigNumber-like .toFixed).
interface BigNumberish { toFixed(dp?: number): string }
interface EngineOrderLike {
  productId: number; price: BigNumberish; totalAmount: BigNumberish; unfilledAmount: BigNumberish;
  expiration: number; nonce: string; digest: string; placementTime: number;
  appendix?: { orderExecutionType?: string; reduceOnly?: boolean };
}
interface NadoEnvelope { status?: string; error?: string; error_code?: number | string; data?: unknown }

function adapterError(message: string, category: AdapterError["category"] = "rejected", raw?: unknown): AdapterError {
  return { category, retrySafe: category === "retryable-safe", message, raw: raw ?? null };
}

const sigHex = (s: Hex | Uint8Array): string => (typeof s === "string" ? s : toHex(s));
// Nado unit split: SIZE-domain values (amount/size) are X18 integers; PRICE-domain
// values (order price) are HUMAN decimals. x18ToDec is for the former, humanDec the latter.
const x18ToDec = (v: BigNumberish): Decimal => formatUnits(BigInt(v.toFixed(0)), 18) as Decimal;
const humanDec = (v: BigNumberish): Decimal => v.toFixed() as Decimal;
const absBig = (v: bigint): bigint => (v < 0n ? -v : v);

export function createLiveNadoGateway(deps: LiveNadoGatewayDeps): NadoGateway {
  const marketIdByProduct = new Map<number, MarketId>(
    Object.entries(deps.productIds).map(([mid, pid]) => [pid, mid as MarketId]),
  );

  // Single-flight the subaccount summary: getBalances + getPositions both derive from it
  // and fire together each poll. Coalesce concurrent reads into ONE metered sequencer
  // call; the promise clears on settle so the NEXT poll refetches (fresh data, one call
  // per wallet per poll instead of two — halves the read pressure against the per-IP budget).
  const summaryInFlight = new Map<string, Promise<{ balances?: Array<Record<string, unknown>> }>>();
  function summaryOnce(subaccount: string): Promise<{ balances?: Array<Record<string, unknown>> }> {
    const key = `${deps.owner}:${subaccount}`;
    let p = summaryInFlight.get(key);
    if (!p) {
      p = (async () => {
        await deps.limiter.acquire("nado:rest", 1);
        return (await deps.engine.getSubaccountSummary({ subaccountOwner: deps.owner, subaccountName: subaccount })) as unknown as { balances?: Array<Record<string, unknown>> };
      })().finally(() => summaryInFlight.delete(key));
      summaryInFlight.set(key, p);
    }
    return p;
  }

  function assertOk(res: unknown): NadoEnvelope {
    const r = (res ?? {}) as NadoEnvelope;
    if (r.status && r.status !== "success") {
      throw adapterError(`sequencer ${r.error_code ?? ""}: ${r.error ?? "rejected"}`.trim(), "rejected", res);
    }
    // A body carrying an error but NO status (e.g. the relay's own 502 {error} envelope, or a
    // malformed response) is a failure too — never let it fall through as a silent "open".
    if (!r.status && r.error) {
      throw adapterError(`relay/sequencer error: ${r.error}`, "network", res);
    }
    return r;
  }

  function mapOrder(o: EngineOrderLike): Order {
    const total = BigInt(o.totalAmount.toFixed(0));
    const unfilled = BigInt(o.unfilledAmount.toFixed(0));
    const postOnly = o.appendix?.orderExecutionType === "post_only";
    return {
      clientId: "", venueId: o.digest,
      market: marketIdByProduct.get(o.productId) ?? (`nado:product:${o.productId}` as MarketId),
      side: total >= 0n ? "buy" : "sell", kind: "limit", role: postOnly ? "maker" : "unknown",
      price: humanDec(o.price), // price-domain → HUMAN (not X18)
      size: formatUnits(absBig(total), 18) as Decimal,
      filled: formatUnits(absBig(total - unfilled), 18) as Decimal,
      remaining: formatUnits(absBig(unfilled), 18) as Decimal,
      postOnly, reduceOnly: o.appendix?.reduceOnly ?? false,
      status: absBig(unfilled) < absBig(total) ? "partial" : "open",
      createdMs: Number(o.placementTime) || Date.now(), updatedMs: Date.now(), raw: o,
    };
  }

  return {
    async submitOrder(signed: BuiltOrder & { signature: Hex | Uint8Array }): Promise<SubmitOrderResult> {
      const built = deps.engine.payloadBuilder.buildPlaceOrderPayloadSync({
        productId: signed.productId,
        order: signed.order as never,
        signature: sigHex(signed.signature),
        verifyingAddr: getOrderVerifyingAddress(signed.productId),
        chainId: deps.chainId,
      } as never);
      const res = await deps.transport.request<NadoEnvelope>({
        bucket: "nado:place", scope: "subaccount", weight: 1, key: signed.sender,
        method: "POST", url: `${deps.engineUrl}/execute`, body: { place_order: (built as { payload: unknown }).payload },
      });
      const r = assertOk(res);
      const data = (r.data ?? {}) as { digest?: string };
      const digest = data.digest ?? (r as { digest?: string }).digest ?? "";
      return { digest: String(digest), status: "open", raw: res };
    },

    async cancelOrders(signed: BuiltCancel & { signature: Hex | Uint8Array }): Promise<CancelResult> {
      const built = deps.engine.payloadBuilder.buildCancelOrdersPayloadSync({
        productIds: signed.productIds,
        digests: signed.digests,
        subaccountOwner: signed.cancel.subaccountOwner,
        subaccountName: signed.cancel.subaccountName,
        nonce: signed.nonce.toString(),
        signature: sigHex(signed.signature),
        verifyingAddr: deps.endpoint,
        chainId: deps.chainId,
      } as never);
      const res = await deps.transport.request<NadoEnvelope>({
        bucket: "nado:rest", scope: "ip", weight: 1,
        method: "POST", url: `${deps.engineUrl}/execute`, body: { cancel_orders: built },
      });
      const r = assertOk(res);
      const data = (r.data ?? {}) as { cancelled_orders?: Array<{ digest?: string }> };
      const cancelled = data.cancelled_orders?.map((c) => String(c.digest ?? "")).filter(Boolean) ?? signed.digests;
      return { cancelled, raw: res };
    },

    async getMarkets(): Promise<Market[]> {
      return [...deps.markets];
    },

    async getOrderBook(market: MarketId, depth = 10): Promise<OrderBook> {
      const productId = deps.productIds[market];
      if (productId == null) return { market, bids: [], asks: [], ts: Date.now(), raw: null };
      await deps.limiter.acquire("nado:rest", 1);
      // getMarketLiquidity maps each tick to { price: HUMAN decimal, liquidity: X18 size }, so price
      // passes through (humanDec) and size converts from X18 (x18ToDec) — same split as orders.
      const resp = (await deps.engine.getMarketLiquidity({ productId, depth })) as unknown as {
        bids?: Array<{ price: BigNumberish; liquidity: BigNumberish }>;
        asks?: Array<{ price: BigNumberish; liquidity: BigNumberish }>;
      };
      const lvl = (t: { price: BigNumberish; liquidity: BigNumberish }) => ({ price: humanDec(t.price), size: x18ToDec(t.liquidity) });
      return { market, bids: (resp.bids ?? []).map(lvl), asks: (resp.asks ?? []).map(lvl), ts: Date.now(), raw: resp };
    },

    async getOpenOrders(subaccount: string): Promise<Order[]> {
      await deps.limiter.acquire("nado:rest", 1);
      // One multi-product query across every known product (not N calls).
      const resp = (await deps.engine.getSubaccountMultiProductOrders({
        subaccountOwner: deps.owner, subaccountName: subaccount, productIds: [...marketIdByProduct.keys()],
      })) as unknown as { productOrders?: Array<{ orders?: EngineOrderLike[] }> };
      const orders: Order[] = [];
      for (const po of resp.productOrders ?? []) for (const o of po.orders ?? []) orders.push(mapOrder(o));
      return orders;
    },

    async getPositions(subaccount: string): Promise<Position[]> {
      const sum = await summaryOnce(subaccount);
      const out: Position[] = [];
      for (const b of sum.balances ?? []) {
        const pid = Number(b["productId"]);
        const market = marketIdByProduct.get(pid);
        if (!market) continue; // only tracked perp/spot markets (not the quote collateral)
        const amtRaw = b["amount"] as BigNumberish | string | number | undefined;
        const amt = amtRaw == null ? 0n : BigInt(typeof amtRaw === "object" ? amtRaw.toFixed(0) : String(amtRaw));
        if (amt === 0n) continue;
        const oracle = b["oraclePrice"] as BigNumberish | undefined;
        out.push({
          market, side: amt > 0n ? "long" : "short",
          size: formatUnits(absBig(amt), 18) as Decimal,
          entryPrice: "0" as Decimal,
          markPrice: (oracle ? humanDec(oracle) : ("0" as Decimal)),
          unrealizedPnl: "0" as Decimal, leverage: 0, marginMode: "cross",
          raw: b,
        });
      }
      return out;
    },

    async getFills(_subaccount: string): Promise<Fill[]> {
      // Fills are a per-wallet WS stream (deferred with the stream multiplexer).
      return [];
    },

    async getBalances(subaccount: string): Promise<Balance[]> {
      const sum = await summaryOnce(subaccount);
      const balances = (sum.balances ?? []) as Array<Record<string, unknown>>;
      return balances.map((b) => {
        const amt = (b["balance"] as { amount?: BigNumberish } | undefined)?.amount ?? (b["amount"] as BigNumberish | undefined);
        const total = amt ? (x18ToDec(amt) as Decimal) : ("0" as Decimal);
        return {
          asset: String(b["productId"] ?? ""), symbol: String(b["symbol"] ?? b["productId"] ?? ""),
          total, available: total, scope: "margin", raw: b,
        };
      });
    },
  };
}
