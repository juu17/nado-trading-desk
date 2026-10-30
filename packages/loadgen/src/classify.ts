// =============================================================================
// @farm/loadgen · classify — dispatch-outcome classification, the single highest-leverage
// factor for a TRUSTWORTHY capacity number (Phase-0 seams contract #3). When a place_order
// relay fails or answers with an error, how we classify it decides whether one order is
// dropped (the run continues) or the whole desk halts — and whether we risk a double-place.
//
// The ledger/coordinator error model this feeds:
//   • not-sent      → the order PROVABLY never reached the matching book. The ledger marks it
//                     ABORTED_UNSENT (no halt, nonce still reserved); one order lost. A
//                     sub-saturation transient MUST land here, not in `unknown`, or a clean
//                     run halts early and UNDER-reports capacity (seams contract #3).
//   • refused       → the sequencer RECEIVED it and rejected it on market-state/admissibility
//                     grounds (never placed). One order; the round re-prices next tick.
//   • rejected-fatal→ a malformed / mis-signed request. Stops all trading for operator review.
//   • deduped       → ENGINE 2013 DIGEST_ALREADY_EXISTS: a byte-identical RETRY whose first
//                     attempt already landed. This is the no-double-place guarantee firing —
//                     treat as SUCCESS (the order IS placed), never as a failure.
//   • unknown       → ambiguous (a post-send timeout, an unrecognized response). The order is
//                     "maybe placed, query first" — NEVER "didn't place" (the non-negotiable
//                     rule). Trips the global halt until positively reconciled.
//
// 🚨 The exact code→kind sets below are grounded in the project's nado-order-dedup-semantics +
// nado-sequencer-accept-encoding-waf notes, but the LIVE sequencer's full code table must be
// confirmed at the testnet gate (mock-connector-first). An UNRECOGNISED code defaults to
// `unknown` on purpose: ambiguous is safe (never double-place), the operator resolves it.
// =============================================================================

export type DispatchKind = "deduped" | "not-sent" | "refused" | "rejected-fatal" | "unknown";

/** Normalised view of a failed dispatch, extracted from the raw transport/relay error by the
 *  connector. The extraction (raw → this) is the one part the testnet gate must verify against
 *  the real Nado response shapes; this classifier is pure policy over the normalised form. */
export interface DispatchErrorInfo {
  /** Sequencer ENGINE_ERROR code, when the response carried one (e.g. 2013, 2011, 2007). */
  nadoCode?: number;
  /** Transport HTTP status, when the failure was an HTTP error (e.g. 403, 429, 502). */
  httpStatus?: number;
  /** The Cloudflare WAF "Invalid compression headers" 403 (never reached the sequencer). */
  wafCompressionBlock?: boolean;
  /** Positive local proof the request was aborted / failed BEFORE any byte left the client
   *  (pre-send abort, DNS/TCP failure). Distinct from a timeout AFTER sending. */
  transportAborted?: boolean;
  message?: string;
}

export interface DispatchVerdict {
  kind: DispatchKind;
  /** A stable code for the row/pause reason (an ENGINE code string, or a symbolic transport reason). */
  code: string;
}

/** ENGINE_ERROR_CODES.DIGEST_ALREADY_EXISTS — a resubmitted identical digest. The order is placed. */
export const DIGEST_ALREADY_EXISTS = 2013;

/** Market-state / admissibility refusals: received by the sequencer, not placed, safe to re-price.
 *  2000 invalid-order-price (not tick-divisible — provably NOT placed, re-price; never unknown→halt),
 *  2011 late-recv, 2004 expired, 2007 price-band, 2008 post-only-would-cross, 2006/2036/2092
 *  margin/health, 2003/2094/2119 min-size (the coordinator treats {2003,2067,2094,2119} as
 *  below-minimum size refusals — keep this set in sync), 2023 address-screening, 2067
 *  reduce-only-not-applicable, 2069 trading-blocked-for-this-market, 2070 market-at-max-open-
 *  interest (close-only). 2008 + 2069 + 2070 were LIVE-confirmed 2026-10-30 (a post-only maker
 *  that crossed a moved book; a disabled testnet perp; an at-OI-cap perp) — all per-order
 *  refusals, NOT maybe-placed unknown→halt; the round re-prices / the operator re-selects. A
 *  refusal is the SAFE bucket (one order, no halt); the full table was cross-checked at the gate. */
export const REFUSAL_CODES: ReadonlySet<number> = new Set([2000, 2011, 2004, 2007, 2008, 2006, 2036, 2092, 2003, 2094, 2119, 2023, 2067, 2069, 2070]);

/** Malformed / mis-signed: the request itself is wrong, so every like order would fail — stop all.
 *  2095 invalid appendix; extend only with codes confirmed to mean "the client built it wrong". */
export const FATAL_CODES: ReadonlySet<number> = new Set([2095]);

/** Rate-limit codes (1000/1015) and HTTP 429: the exchange shed the request; it never took it. */
export const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([1000, 1015]);

export function classifyDispatch(info: DispatchErrorInfo): DispatchVerdict {
  // The no-double-place guarantee firing: a retry's identical digest was deduped → placed.
  if (info.nadoCode === DIGEST_ALREADY_EXISTS) return { kind: "deduped", code: "DIGEST_ALREADY_EXISTS" };

  // Provably never crossed transport — a pre-send abort / TCP failure, or the Cloudflare WAF
  // compression 403 that blocks the request before it reaches the sequencer.
  if (info.transportAborted) return { kind: "not-sent", code: "TRANSPORT_ABORTED" };
  if (info.wafCompressionBlock || (info.httpStatus === 403 && /compression|invalid compression headers/i.test(info.message ?? "")))
    return { kind: "not-sent", code: "WAF_COMPRESSION_BLOCK" };

  // Rate limited: the exchange never accepted it (no phantom order to look up); back off.
  if ((info.nadoCode !== undefined && RATE_LIMIT_CODES.has(info.nadoCode)) || info.httpStatus === 429)
    return { kind: "not-sent", code: "RATE_LIMITED" };

  // Received-and-refused on market-state grounds: one order, re-price next tick.
  if (info.nadoCode !== undefined && REFUSAL_CODES.has(info.nadoCode)) return { kind: "refused", code: String(info.nadoCode) };

  // Malformed / mis-signed: stop all for review.
  if (info.nadoCode !== undefined && FATAL_CODES.has(info.nadoCode)) return { kind: "rejected-fatal", code: String(info.nadoCode) };

  // Anything else (post-send timeout, 5xx, an unrecognised code) is AMBIGUOUS: maybe placed.
  // Never classified as not-sent without positive proof — "UNKNOWN != didn't place".
  return { kind: "unknown", code: "ORDER_RESULT_UNKNOWN" };
}
