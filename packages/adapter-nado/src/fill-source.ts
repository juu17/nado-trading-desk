// =============================================================================
// @farm/adapter-nado · fill-source — the Nado-native reads behind A-5 (authoritative
// per-order fill). The seam `OrderFillSource` (in @farm/loadgen) is implemented on top
// of these; this file holds ONLY Nado wire shapes (core-free, like the rest of the
// adapter). Three authoritative sources, per the Phase-A testnet-validation design:
//
//   • RESTING MAKER      → engine `getOrder({productId,digest})` → raw X18
//                          totalAmount/unfilledAmount. filled = |total| − |unfilled|.
//   • TAKER (IOC) / FILLS → the keyless PUBLIC `fill` WS stream, summed by digest in a
//                          pure `FillAccumulator` (the stream is the WAKE transport AND
//                          the per-fill feed; authoritative cumulative values are derived
//                          with correct unit math — see below).
//   • TERMINALITY / recon → a FRESH `getSubaccountSummary` net position (A-5: finality is
//                          proven by position reconciliation, never by a missing cancel row).
//
// 🚨 UNIT + SEMANTIC pins (the pre-audit caught these; confirm the raw frame live at the
//    testnet gate — docs/phasea-testnet-validation.md §2):
//   - The raw subscription `fill` frame fields (filled_qty / remaining_qty / original_qty /
//     price / fee) are X18 integers (the frame is raw server, NOT SDK-mapped — unlike a
//     query, where price is a human decimal).
//   - quote is NOT filled×price at the top level (that is X36); quote increment is
//     Δbase_X18 × price_X18 / 1e18. Summed over fills → cumulative quoteX18.
//   - fee is summed then clamped to ≥ 0: a maker REBATE (negative fee) counts as zero cost,
//     never a negative/decreasing cumulative (the coordinator refuses a regressed fee).
//   - cumulative base is derived from the (original − remaining) PROGRESSION (robust whether
//     the frame's filled_qty is per-match-incremental or cumulative), deduped by
//     submission_idx and ordered by it.
// =============================================================================
import { formatUnits } from "viem";

/** Raw public `fill` stream frame (keyless `fill` stream; X18 integer string fields). Shape
 *  per @nadohq EngineServerSubscriptionFillEvent; confirmed live at the testnet gate. */
export interface NadoFillFrame {
  product_id: number;
  subaccount: string;       // bytes32 owner++name (the frame's subaccount)
  order_digest: string;     // the order this fill belongs to (match key)
  filled_qty: string;       // X18 (per-match or cumulative — we use original−remaining)
  remaining_qty: string;    // X18 remaining after this event
  original_qty: string;     // X18 original order size
  price: string;            // X18 fill price (raw frame → X18, NOT human)
  is_taker: boolean;
  is_bid?: boolean;
  fee: string;              // X18 fee for this match (negative = maker rebate)
  submission_idx: string;   // monotonic sequence id (dedup/order key)
}

/** Cumulative confirmed fill for one order digest (all X18 integer strings). */
export interface CumulativeFill {
  baseFilledX18: string;
  quoteFilledX18: string;
  feePaidX18: string;       // clamped ≥ 0 (rebates are zero cost, never negative)
}

const absBig = (v: bigint): bigint => (v < 0n ? -v : v);

/** Pure accumulator over the public `fill` stream, keyed by order digest. Fed by
 *  `subscribeFills` (live) or directly (tests). Monotonic + unit-correct by construction. */
export class FillAccumulator {
  // digest → (submission_idx → frame). The inner map dedups redelivered frames and lets us
  // order by submission_idx; we never trust arrival order.
  private readonly byDigest = new Map<string, Map<string, NadoFillFrame>>();

  ingest(frame: NadoFillFrame): void {
    if (!frame || !frame.order_digest) return;
    let m = this.byDigest.get(frame.order_digest);
    if (!m) { m = new Map(); this.byDigest.set(frame.order_digest, m); }
    // Last write wins per submission_idx (idempotent redelivery); an empty/missing idx is
    // bucketed under its own key so distinct fills without an idx are not collapsed.
    m.set(String(frame.submission_idx ?? `_${m.size}`), frame);
  }

  /** The cumulative fill for a digest, or undefined if no frame has been seen for it yet
   *  (the caller treats "undefined" as not-yet-observable, NOT as zero-filled). */
  get(digest: string): CumulativeFill | undefined {
    const m = this.byDigest.get(digest);
    if (!m || m.size === 0) return undefined;
    // Order by submission_idx ascending (BigInt-safe; non-numeric idx sorts last, stably).
    const frames = [...m.values()].sort((a, b) => cmpIdx(a.submission_idx, b.submission_idx));
    let prevCum = 0n;          // previous cumulative base (original − remaining)
    let quote = 0n;            // Σ Δbase × price / 1e18
    let fee = 0n;              // Σ fee (clamped ≥ 0 at the end)
    let maxCum = 0n;           // cumulative base = max (original − remaining) seen
    for (const f of frames) {
      const original = big(f.original_qty), remaining = big(f.remaining_qty);
      const cum = absBig(original) - absBig(remaining);          // cumulative filled at this frame
      const inc = cum - prevCum;                                  // per-frame base increment
      if (inc > 0n) quote += (inc * absBig(big(f.price))) / 10n ** 18n; // X18×X18/1e18 = X18 quote
      prevCum = cum > prevCum ? cum : prevCum;                    // guard against out-of-order dips
      if (cum > maxCum) maxCum = cum;
      fee += big(f.fee);
    }
    return {
      baseFilledX18: (maxCum < 0n ? 0n : maxCum).toString(),
      quoteFilledX18: (quote < 0n ? 0n : quote).toString(),
      feePaidX18: (fee < 0n ? 0n : fee).toString(),              // rebate → 0 cost (never negative)
    };
  }

  /** Drop a digest's accumulated frames (e.g. once an order is terminal + accounted). */
  forget(digest: string): void { this.byDigest.delete(digest); }
}

function big(v: string | undefined): bigint {
  if (v == null) return 0n;
  // X18 integer strings only; tolerate a stray decimal by truncating (defensive — the raw
  // frame is integer X18, but a mapped value could sneak a ".0").
  const s = String(v).split(".")[0] || "0";
  try { return BigInt(s); } catch { return 0n; }
}
function cmpIdx(a: string | undefined, b: string | undefined): number {
  const na = numOrNull(a), nb = numOrNull(b);
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  if (na !== null) return -1;      // numeric idx before non-numeric
  if (nb !== null) return 1;
  return String(a ?? "").localeCompare(String(b ?? ""));
}
function numOrNull(v: string | undefined): bigint | null {
  if (v == null || !/^\d+$/.test(v)) return null;
  try { return BigInt(v); } catch { return null; }
}

// -----------------------------------------------------------------------------
// Live reads behind the OrderFillSource. Structural engine type so the adapter stays
// decoupled + unit-testable (the real @nadohq EngineClient satisfies it).
// -----------------------------------------------------------------------------
interface BigNumberish { toFixed(dp?: number): string }
export interface EngineOrderQueryLike {
  getOrder(params: { productId: number; digest: string }): Promise<{ totalAmount: BigNumberish; unfilledAmount: BigNumberish } | null | undefined>;
  getSubaccountSummary(params: { subaccountOwner: string; subaccountName: string }): Promise<{ balances?: Array<Record<string, unknown>> }>;
}

/** The result of asking the engine whether an order still rests. `unavailable` (a transport /
 *  WAF failure) is DISTINCT from `not-found` (a structured "no such order"): only `not-found`
 *  means the order left the book; `unavailable` must never be read as terminal. */
export type RestingOrderResult =
  | { kind: "resting"; totalAmountX18: string; unfilledAmountX18: string }
  | { kind: "not-found" }
  | { kind: "unavailable" };

/** The injectable per-order reads the live OrderFillSource composes. */
export interface NadoFillReads {
  restingOrder(owner: string, productId: number, digest: string): Promise<RestingOrderResult>;
  cumulativeFills(owner: string, productId: number, digest: string): Promise<CumulativeFill | undefined>;
  netPositionX18(owner: string, productId: number): Promise<string>;
}

export interface NadoFillReadsDeps {
  engine: EngineOrderQueryLike;
  accumulator: FillAccumulator;
  subaccountName?: string;                         // "default"
  /** Read-budget gate; `urgent` for the fill-critical follow/cancel reads so a 429 cooldown
   *  never freezes a pending fill. Omitted in tests. */
  acquire?: (urgent?: boolean) => Promise<void>;
  /** Structured "order not found" detector for a getOrder rejection — the ONLY signal that an
   *  order has left the book. Everything else (transport/WAF/timeout) is `unavailable`.
   *  Confirmed against the live sequencer's not-found shape at the testnet gate. */
  isOrderNotFound?: (error: unknown) => boolean;
}

const defaultIsOrderNotFound = (error: unknown): boolean => {
  const e = (error ?? {}) as { message?: unknown };
  const msg = typeof e.message === "string" ? e.message : "";
  // Best-effort until pinned live (docs/phasea-testnet-validation.md §2): an explicit
  // not-found-ish message only — NEVER infer "gone" from a transport/WAF/timeout failure.
  return /not[\s_-]?found|no such order|unknown order|does not exist/i.test(msg);
};

export function createNadoFillReads(deps: NadoFillReadsDeps): NadoFillReads {
  const subaccountName = deps.subaccountName ?? "default";
  const isNotFound = deps.isOrderNotFound ?? defaultIsOrderNotFound;
  const gate = async (urgent?: boolean) => { if (deps.acquire) await deps.acquire(urgent); };

  return {
    async restingOrder(_owner, productId, digest): Promise<RestingOrderResult> {
      await gate(true); // fill-critical
      try {
        const o = await deps.engine.getOrder({ productId, digest });
        if (!o) return { kind: "not-found" };
        return { kind: "resting", totalAmountX18: o.totalAmount.toFixed(0), unfilledAmountX18: o.unfilledAmount.toFixed(0) };
      } catch (error) {
        return isNotFound(error) ? { kind: "not-found" } : { kind: "unavailable" };
      }
    },

    async cumulativeFills(_owner, _productId, digest): Promise<CumulativeFill | undefined> {
      // Fills come from the public `fill` stream the accumulator is fed from; no network here
      // (the subscription is the wake transport). Returns undefined until a frame is seen.
      return deps.accumulator.get(digest);
    },

    async netPositionX18(owner, productId): Promise<string> {
      await gate(true);
      const sum = await deps.engine.getSubaccountSummary({ subaccountOwner: owner, subaccountName });
      let net = 0n;
      for (const b of sum.balances ?? []) {
        if (Number(b["productId"]) !== productId) continue;
        const amtRaw = b["amount"] as BigNumberish | string | number | undefined;
        if (amtRaw == null) continue;
        net += typeof amtRaw === "object" ? BigInt(amtRaw.toFixed(0)) : BigInt(String(amtRaw).split(".")[0] || "0");
      }
      return net.toString();
    },
  };
}

// -----------------------------------------------------------------------------
// Keyless public `fill` stream subscription → feeds the accumulator. The socket is
// injectable (a structural WebSocket) so the subscribe/parse plumbing is unit-tested with
// no network. This is the WAKE transport (order_update, by contrast, needs per-wallet EIP-712
// auth — see memory order-update-ws-auth); the `fill` stream is keyless/direct.
// -----------------------------------------------------------------------------
export interface SocketLike {
  send(data: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: { data?: unknown }) => void): void;
  readyState?: number;
}

export interface SubscribeFillsOpts {
  /** Called whenever a fill frame lands (the wake hint) — e.g. to nudge the driver's poll. */
  onWake?: (digest: string) => void;
  /** Starting request id (ids increment from here). */
  startId?: number;
}

/** Subscribe the keyless `fill` stream for each subaccount (bytes32 sender) and route every
 *  fill frame into the accumulator. Returns a disposer. No auth frame is sent (keyless). */
export function subscribeFills(
  socket: SocketLike,
  subaccounts: readonly string[],
  acc: FillAccumulator,
  opts: SubscribeFillsOpts = {},
): () => void {
  let id = opts.startId ?? 1;
  let disposed = false;
  const subscribe = () => {
    for (const subaccount of subaccounts) {
      socket.send(JSON.stringify({ id: id++, method: "subscribe", stream: { type: "fill", subaccount } }));
    }
  };
  const onOpen = () => { if (!disposed) subscribe(); };
  const onMessage = (ev: { data?: unknown }) => {
    if (disposed) return;
    let m: unknown;
    try { m = JSON.parse(String(ev?.data ?? "")); } catch { return; }
    const frame = m as Partial<NadoFillFrame> & { type?: string };
    if (frame && frame.type === "fill" && typeof frame.order_digest === "string") {
      acc.ingest(frame as NadoFillFrame);
      opts.onWake?.(frame.order_digest);
    }
  };
  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", onMessage);
  // If the socket is already open, subscribe now (the "open" event already fired).
  if (socket.readyState === 1 /* OPEN */) subscribe();
  return () => { disposed = true; };
}
