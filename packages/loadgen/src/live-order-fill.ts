// =============================================================================
// @farm/loadgen · live-order-fill — the LIVE A-5 OrderFillSource. Composes the Nado reads
// (@farm/adapter-nado fill-source) into the authoritative per-order fill the coordinator's
// lookup()/cancel() consume. Query/position-authoritative, with the public `fill` stream used
// as the WAKE transport + per-fill feed (NOT as the sole source of truth):
//
//   • resting MAKER       → engine getOrder raw X18 (filled = |total|−|unfilled|).
//   • taker (IOC) / fills → the keyless `fill` stream, summed by digest (unit-correct, monotonic).
//   • terminality         → engine "gone from the book" + confirmed cumulative fills; the fresh
//                           net position reconciliation is the testnet-gate assertion (§2).
//
// The pre-audit (A-5) hardened these contracts — each is tested in live-order-fill.test.ts:
//   #4/#5 a gone order with NO confirmed fill yet returns `undefined` (not-observable → the
//         coordinator's lag window waits), NEVER {filled:0, terminal:true} (which would make
//         the coordinator re-send a duplicate live order).
//   #6    a fully-filled maker the engine still echoes (unfilled==0) IS terminal (never stalls).
//   #7    terminal is only declared WITH its final accounting (quote/fee), never frozen at 0.
//   #8    a transport/WAF read failure is `unavailable` → not-observable, NEVER read as "gone".
//   #9    base filled is raw X18 (engine total/unfilled), never the human-decimal mapped Order.
// =============================================================================
import type { OrderFillSource } from "./experiment-connector.js";
import type { NadoFillReads } from "@farm/adapter-nado";

const absBig = (v: bigint): bigint => (v < 0n ? -v : v);
const toBig = (s: string): bigint => { try { return BigInt(String(s).split(".")[0] || "0"); } catch { return 0n; } };

/**
 * Build the live OrderFillSource from the injected Nado reads. Pure composition logic — the
 * reads (engine getOrder / the fill accumulator / the summary position) are faked in tests and
 * wired to the real keyless EngineClient + public `fill` stream at the testnet gate.
 */
export function createLiveOrderFillSource(reads: NadoFillReads): OrderFillSource {
  return async (owner, productId, digest) => {
    const resting = await reads.restingOrder(owner, productId, digest);
    // #8 — a transport/WAF/timeout failure is NOT evidence the order is gone. Report
    // "not observable" (undefined) so the coordinator's lag machinery waits; never terminal.
    if (resting.kind === "unavailable") return undefined;

    const fills = await reads.cumulativeFills(owner, productId, digest);

    if (resting.kind === "resting") {
      const total = absBig(toBig(resting.totalAmountX18));
      const unfilled = absBig(toBig(resting.unfilledAmountX18));
      const filledX18 = (total - unfilled).toString(); // #9 raw X18
      if (unfilled > 0n) {
        // Still on the book — a resting maker (possibly partially filled). Monotonic partial
        // accounting from the stream; quote/fee default to 0 until a fill frame lands.
        return {
          filledX18,
          quoteFilledX18: fills?.quoteFilledX18 ?? "0",
          feePaidX18: fills?.feePaidX18 ?? "0",
          terminal: false,
          resting: true,
        };
      }
      // #6 — fully filled but the engine still echoes it (unfilled==0): terminal, NOT a stall.
      // #7 — but hold terminal until the stream has delivered the accounting (quote/fee); the
      //      base is already authoritative from getOrder. Until then: known, settling, poll again.
      if (!fills) return { filledX18, quoteFilledX18: "0", feePaidX18: "0", terminal: false, resting: false };
      return { filledX18, quoteFilledX18: fills.quoteFilledX18, feePaidX18: fills.feePaidX18, terminal: true, resting: false };
    }

    // resting.kind === "not-found" → the order has left the book (a taker IOC that never rests,
    // or a filled-and-purged maker).
    // #4/#5 — gone but no confirmed fill observed yet: NOT terminal, NOT zero-filled. Return
    //         undefined so lookup() reports identityMatches:true/known:false and the coordinator
    //         waits out the pre-observation lag instead of re-sending a duplicate order.
    if (!fills) return undefined;
    // Authoritative terminal accounting from the fill stream (base/quote/fee all X18, monotonic,
    // fee clamped ≥ 0). The fresh-position reconciliation is the testnet-gate check (§2).
    return {
      filledX18: fills.baseFilledX18,
      quoteFilledX18: fills.quoteFilledX18,
      feePaidX18: fills.feePaidX18,
      terminal: true,
      resting: false,
    };
  };
}
