// What the luck test costs, and when a round may open cheaply. A pair holds opposite,
// equal positions in one market: price moves cancel between A and B, so once a round ends
// with both flat, the pair's combined result is exactly what the round cost.
import type { ExperimentCostGate, ExperimentCostTotals, ExperimentMarketCost, ExperimentOrder, ExperimentRound } from "./types.js";

export interface RoundCost {
  turnoverX18: bigint;
  makerFeeX18: bigint;
  takerFeeX18: bigint;
  /** A fully hedged round: B followed A's whole fill and both closed it (also a round a
   *  pause-and-flatten closed early once it was hedged). */
  hedged: boolean;
  /** Hedged rounds: price cost of the opening and of the closing, positive = cost. */
  openLegX18: bigint;
  closeLegX18: bigint;
  /** Not hedged: the combined price result (market exposure), positive = loss. */
  unhedgedPriceX18: bigint;
  /** From A's fill being seen to B's first follow order being ready to send (ms). */
  followMs?: number;
  /** From B's maker close being seen filled to A's first closing order after it (ms). */
  closeFollowMs?: number;
}
const final = (o: ExperimentOrder) => o.state === "ABORTED_UNSENT" || (o.state === "TERMINAL" && o.factKnown);
/** The cost of a completed round whose every order is final; undefined otherwise (or if
 *  nothing traded). Fees are split by maker (post-only) and taker orders. */
export function roundCost(r: ExperimentRound): RoundCost | undefined {
  if (r.state !== "COMPLETED" || !r.orders.every(final)) return undefined;
  const done = r.orders.filter((o) => o.state === "TERMINAL");
  if (!done.some((o) => BigInt(o.filledX18) > 0n)) return undefined;
  const sum = (list: ExperimentOrder[], f: (o: ExperimentOrder) => bigint) => list.reduce((n, o) => n + f(o), 0n);
  const role = (...roles: string[]) => done.filter((o) => roles.includes(o.role));
  const qty = (r: string) => sum(role(r), (o) => BigInt(o.filledX18));
  // Sells bring quote in, buys pay it out; the negative of the sum is what was lost.
  const lost = (list: ExperimentOrder[]) => -sum(list, (o) => (o.side === "SELL" ? 1n : -1n) * BigInt(o.quoteFilledX18));
  const opened = qty("A_OPEN");
  const follow = r.orders.find((o) => o.role === "B_OPEN" && o.state !== "ABORTED_UNSENT");
  const followMs = r.sourceFilledAt !== undefined && follow ? Math.max(0, follow.createdAt - r.sourceFilledAt) : undefined;
  const seen = r.closeSourceFilledAt;
  const closer = seen === undefined ? undefined : r.orders.find((o) => o.role === "A_CLOSE" && o.state !== "ABORTED_UNSENT" && o.createdAt >= seen);
  const closeFollowMs = seen !== undefined && closer ? closer.createdAt - seen : undefined;
  const hedged = opened > 0n && qty("B_OPEN") === opened && qty("A_CLOSE") === opened && qty("B_CLOSE") === opened;
  return {
    turnoverX18: sum(done, (o) => BigInt(o.quoteFilledX18)),
    makerFeeX18: sum(done.filter((o) => o.postOnly), (o) => BigInt(o.feePaidX18)),
    takerFeeX18: sum(done.filter((o) => !o.postOnly), (o) => BigInt(o.feePaidX18)),
    hedged,
    openLegX18: hedged ? lost(role("A_OPEN", "B_OPEN")) : 0n,
    closeLegX18: hedged ? lost(role("A_CLOSE", "B_CLOSE")) : 0n,
    unhedgedPriceX18: hedged ? 0n : lost(done),
    ...(followMs !== undefined ? { followMs } : {}),
    ...(closeFollowMs !== undefined ? { closeFollowMs } : {}),
  };
}
/**
 * One completed round's cost as plain numbers for the diagnostic log (no address, digest or
 * payload): turnover in USDT0, each part in bps of turnover, the share of turnover that
 * rested as maker (overall and of B's close), and the follow delays: from a fill first seen
 * to the hedging order signed (opening: A's maker -> B's IOC; closing: B's maker -> A's
 * close). That is part of the one-sided time, not all of it (sending and the hedge's own
 * fill come after; audit 12.2D). Undefined
 * when the round has no cost (nothing filled or an order not final).
 */
export function roundCostFacts(r: ExperimentRound): Record<string, number> | undefined {
  const c = roundCost(r); if (!c || c.turnoverX18 <= 0n) return undefined;
  const turnover = Number(c.turnoverX18) / 1e18, bps = (x: bigint) => Math.round(Number(x) / 1e18 / turnover * 1e4 * 1000) / 1000;
  const done = r.orders.filter((o) => o.state === "TERMINAL"), quote = (list: ExperimentOrder[]) => list.reduce((n, o) => n + BigInt(o.quoteFilledX18), 0n);
  const bClose = done.filter((o) => o.role === "B_CLOSE"), share = (x: bigint, of: bigint) => of > 0n ? Math.round(Number(x * 10000n / of)) / 10000 : 0;
  return {
    turnoverU: Math.round(turnover * 100) / 100,
    feeBps: bps(c.makerFeeX18 + c.takerFeeX18), makerFeeBps: bps(c.makerFeeX18), takerFeeBps: bps(c.takerFeeX18),
    openLegBps: bps(c.openLegX18), closeLegBps: bps(c.closeLegX18), unhedgedBps: bps(c.unhedgedPriceX18),
    makerShare: share(quote(done.filter((o) => o.postOnly)), c.turnoverX18),
    closeMakerShare: share(quote(bClose.filter((o) => o.postOnly)), quote(bClose)),
    hedged: c.hedged ? 1 : 0,
    // Both from "a fill first seen" to "the hedging order signed", not to its send or its fill:
    // a part of the one-sided time only (audit 12.2D).
    ...(c.followMs !== undefined ? { openFillSeenToFollowSignedMs: c.followMs } : {}),
    ...(c.closeFollowMs !== undefined ? { closeFillSeenToFollowSignedMs: c.closeFollowMs } : {}),
    ...(r.costWaitMs !== undefined ? { gateWaitMs: r.costWaitMs } : {}),
  };
}
const add = (a: string | undefined, b: bigint) => String(BigInt(a ?? "0") + b);
/** The task's totals with one more completed round (and its wait for a calm market). */
export function addRoundCost(t: ExperimentCostTotals | undefined, c: RoundCost, waitedMs?: number): ExperimentCostTotals {
  return {
    rounds: (t?.rounds ?? 0) + 1,
    turnoverX18: add(t?.turnoverX18, c.turnoverX18),
    makerFeeX18: add(t?.makerFeeX18, c.makerFeeX18),
    takerFeeX18: add(t?.takerFeeX18, c.takerFeeX18),
    hedgedRounds: (t?.hedgedRounds ?? 0) + (c.hedged ? 1 : 0),
    hedgedTurnoverX18: add(t?.hedgedTurnoverX18, c.hedged ? c.turnoverX18 : 0n),
    openLegX18: add(t?.openLegX18, c.openLegX18),
    closeLegX18: add(t?.closeLegX18, c.closeLegX18),
    unhedgedPriceX18: add(t?.unhedgedPriceX18, c.unhedgedPriceX18),
    ...(waitedMs !== undefined || t?.gatedRounds !== undefined
      ? { gatedRounds: (t?.gatedRounds ?? 0) + (waitedMs !== undefined ? 1 : 0), gateWaitMs: (t?.gateWaitMs ?? 0) + (waitedMs ?? 0) } : {}),
    ...(c.followMs !== undefined || t?.followRounds !== undefined
      ? { followRounds: (t?.followRounds ?? 0) + (c.followMs !== undefined ? 1 : 0), followMs: (t?.followMs ?? 0) + (c.followMs ?? 0) } : {}),
    ...(c.closeFollowMs !== undefined || t?.closeFollowRounds !== undefined
      ? { closeFollowRounds: (t?.closeFollowRounds ?? 0) + (c.closeFollowMs !== undefined ? 1 : 0), closeFollowMs: (t?.closeFollowMs ?? 0) + (c.closeFollowMs ?? 0) } : {}),
  };
}

/** Facts read for fewer than this many samples, or over less than this span, are too
 *  thin to call the market calm. */
export const COST_GATE_MIN_SAMPLES = 20;
export const COST_GATE_MIN_SPAN_MS = 40_000;
/** Without enough facts (unreadable, or too few samples, e.g. while reads are busy with
 *  trading) a round waits at most this long: waiting the full limit would only slow the
 *  task without telling calm from busy. */
export const COST_GATE_DATA_WAIT_MS = 60_000;
export interface CostGateDecision { open: boolean; code?: string; timedOut?: boolean }
/**
 * Whether a round may open now. Waiting is never forever: after the gate's maxWaitMs the
 * round opens as it would have without the gate (also when the facts cannot be read).
 * Unreadable or thin facts are never taken as calm.
 */
export function costGateDecision(gate: ExperimentCostGate, fact: ExperimentMarketCost | undefined, waitedMs: number): CostGateDecision {
  const reason = !fact ? "COST_GATE_UNREADABLE"
    : fact.samples < COST_GATE_MIN_SAMPLES || fact.spanMs < COST_GATE_MIN_SPAN_MS ? "COST_GATE_WARMING"
    : fact.spreadTicks > gate.maxSpreadTicks ? "COST_GATE_SPREAD_WIDE"
    : gate.maxDriftBps !== undefined && fact.driftBps > gate.maxDriftBps ? "COST_GATE_VOLATILE"
    : gate.relative && fact.medianDriftBps !== undefined && fact.driftBps > fact.medianDriftBps ? "COST_GATE_VOLATILE"
    : undefined;
  if (!reason) return { open: true };
  const limit = reason === "COST_GATE_UNREADABLE" || reason === "COST_GATE_WARMING" ? Math.min(gate.maxWaitMs, COST_GATE_DATA_WAIT_MS) : gate.maxWaitMs;
  if (waitedMs >= limit) return { open: true, timedOut: true, code: reason };
  return { open: false, code: reason };
}
export const COST_GATE_CODES = ["COST_GATE_UNREADABLE", "COST_GATE_WARMING", "COST_GATE_SPREAD_WIDE", "COST_GATE_VOLATILE"] as const;
