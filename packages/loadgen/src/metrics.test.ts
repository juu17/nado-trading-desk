// Guards the capacity readout (B-3 / decision #1): matched fills/sec (window-anchored, so a
// post-knee stall is not hidden as a high burst rate) + p50/p99 fill↔follow latency, and the
// curve vs N. A "matched fill" = a terminal-filled taker cross (B_OPEN open, A_CLOSE close);
// latency = |taker.createdAt − fill-seen| (cost.ts followMs in the organic case; the engine
// fill-confirm latency under the self-cross default, where the taker is signed before its fill).
import { describe, expect, it } from "vitest";
import type { ExperimentCampaign, ExperimentOrder, ExperimentOrderRole, ExperimentRound } from "@farm/core";
import { RunMetrics, extractRoundMetrics, percentile, aggregateCurve, type RunSummary } from "./metrics.js";

const ord = (
  role: ExperimentOrderRole,
  o: { filled?: string; quote?: string; createdAt?: number; state?: ExperimentOrder["state"]; id?: string } = {},
): ExperimentOrder => ({
  id: o.id ?? `o:${role}`, role, state: o.state ?? "TERMINAL", createdAt: o.createdAt ?? 0,
  filledX18: o.filled ?? "0", quoteFilledX18: o.quote ?? "0", feePaidX18: "0",
  mode: "SIMULATION", chainId: 763373, owner: "0x", productId: 2, digest: "0x", payload: "{}",
  quantityX18: o.filled ?? "0", priceX18: "0", nonce: "1", expiration: 0, side: "BUY",
  reduceOnly: role.endsWith("CLOSE"), postOnly: role === "A_OPEN" || role === "B_CLOSE",
  epoch: 0, factKnown: true,
}) as ExperimentOrder;

const round = (
  number: number, orders: ExperimentOrder[],
  r: { sourceFilledAt?: number; closeSourceFilledAt?: number; state?: ExperimentRound["state"]; id?: string } = {},
): ExperimentRound => ({
  id: r.id ?? `r${number}`, number, openAt: 0, side: "BUY", holdMs: 0, state: r.state ?? "COMPLETED", orders,
  ...(r.sourceFilledAt !== undefined ? { sourceFilledAt: r.sourceFilledAt } : {}),
  ...(r.closeSourceFilledAt !== undefined ? { closeSourceFilledAt: r.closeSourceFilledAt } : {}),
}) as ExperimentRound;

/** A fully-hedged round. ORGANIC ordering: the takers are signed AFTER the fill is seen. */
const hedgedRound = (number: number, base: string, t: { srcAt: number; bOpenAt: number; closeSrcAt: number; aCloseAt: number }): ExperimentRound =>
  round(number, [
    ord("A_OPEN", { filled: base, quote: "100", createdAt: t.srcAt - 10 }),
    ord("B_OPEN", { filled: base, quote: "100", createdAt: t.bOpenAt }),
    ord("B_CLOSE", { filled: base, quote: "100", createdAt: t.closeSrcAt - 10 }),
    ord("A_CLOSE", { filled: base, quote: "100", createdAt: t.aCloseAt }),
  ], { sourceFilledAt: t.srcAt, closeSourceFilledAt: t.closeSrcAt });

describe("metrics — extractRoundMetrics", () => {
  it("a fully-hedged round yields 2 matches (open B_OPEN, close A_CLOSE), 4 filled legs, hedged", () => {
    const m = extractRoundMetrics(hedgedRound(1, "100", { srcAt: 1000, bOpenAt: 1050, closeSrcAt: 2000, aCloseAt: 2080 }));
    expect(m.filledLegs).toBe(4);
    expect(m.hedged).toBe(true);
    expect(m.matches.map((e) => e.leg)).toEqual(["open", "close"]);
    expect(m.matches[0]).toMatchObject({ leg: "open", atMs: 1000, baseX18: "100", quoteX18: "100", latencyMs: 50 });
    expect(m.matches[1]).toMatchObject({ leg: "close", atMs: 2000, baseX18: "100", quoteX18: "100", latencyMs: 80 });
  });

  it("latency is |taker.createdAt − fill-seen|: positive under the SELF-CROSS ordering (taker signed BEFORE its fill)", () => {
    // Self-cross: B's taker is signed (createdAt 1000) then its cross makes A's maker fill, seen at 1050.
    const m = extractRoundMetrics(round(2, [
      ord("A_OPEN", { filled: "5", createdAt: 990 }), ord("B_OPEN", { filled: "5", createdAt: 1000 }),
    ], { sourceFilledAt: 1050 }));
    expect(m.matches[0]).toMatchObject({ leg: "open", atMs: 1050, latencyMs: 50 }); // |1000 − 1050| = 50, not clamped to 0
  });

  it("latency absent (atMs falls back to createdAt) when the fill-seen time was not recorded", () => {
    const m = extractRoundMetrics(round(3, [ord("A_OPEN", { filled: "5" }), ord("B_OPEN", { filled: "5", createdAt: 777 })]));
    expect(m.matches).toHaveLength(1);
    expect(m.matches[0]).toMatchObject({ leg: "open", atMs: 777 });
    expect(m.matches[0]!.latencyMs).toBeUndefined();
  });

  it("counts EACH terminal-filled taker order as a cross (a leg split across two IOCs = two matches, base summed)", () => {
    const m = extractRoundMetrics(round(4, [
      ord("A_OPEN", { filled: "100", createdAt: 0 }),
      ord("B_OPEN", { filled: "60", quote: "60", createdAt: 30, id: "bo1" }),
      ord("B_OPEN", { filled: "40", quote: "40", createdAt: 35, id: "bo2" }),
    ], { sourceFilledAt: 10 }));
    expect(m.matches.map((e) => e.leg)).toEqual(["open", "open"]);
    expect(m.matches.map((e) => e.baseX18)).toEqual(["60", "40"]);
  });

  it("a partial/early-exit round (open only) → 1 match, 2 filled legs, not hedged", () => {
    const m = extractRoundMetrics(round(5, [
      ord("A_OPEN", { filled: "100" }), ord("B_OPEN", { filled: "100", createdAt: 30 }),
    ], { sourceFilledAt: 10 }));
    expect(m.matches.map((e) => e.leg)).toEqual(["open"]);
    expect(m.filledLegs).toBe(2);
    expect(m.hedged).toBe(false);
  });

  it("ignores a non-terminal or zero-fill taker leg", () => {
    expect(extractRoundMetrics(round(6, [ord("B_OPEN", { filled: "0", createdAt: 5 })], { sourceFilledAt: 1 })).matches).toEqual([]);
    expect(extractRoundMetrics(round(7, [ord("B_OPEN", { filled: "10", state: "DISPATCHED", createdAt: 5 })], { sourceFilledAt: 1 })).matches).toEqual([]);
  });
});

describe("metrics — percentile", () => {
  it("nearest-rank, 0 for empty", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([30, 50, 80, 120], 50)).toBe(50);  // ceil(.5*4)=2 → idx1
    expect(percentile([30, 50, 80, 120], 99)).toBe(120); // ceil(.99*4)=4 → idx3
    expect(percentile([10], 99)).toBe(10);
  });
});

describe("metrics — RunMetrics summary + timeseries + curve", () => {
  const run = (): RunMetrics => {
    const m = new RunMetrics();
    m.addRound(hedgedRound(1, "100", { srcAt: 1000, bOpenAt: 1050, closeSrcAt: 2000, aCloseAt: 2080 }));
    m.addRound(hedgedRound(2, "100", { srcAt: 3000, bOpenAt: 3030, closeSrcAt: 4000, aCloseAt: 4120 }));
    return m;
  };

  it("counts matches, filled legs, base/quote, span and the SPAN-based burst rate (no window)", () => {
    const s = run().summary();
    expect(s.matchedFills).toBe(4);
    expect(s.filledLegs).toBe(8);
    expect(s.rounds).toBe(2);
    expect(s.hedgedRounds).toBe(2);
    expect(s.matchedBaseX18).toBe("400");
    expect(s.matchedQuoteX18).toBe("400");
    expect(s.spanMs).toBe(3000);                 // 1000 → 4000
    expect(s.windowed).toBe(false);
    expect(s.fillsPerSec).toBeCloseTo(4 / 3, 6); // span-based approximation
  });

  it("window-anchored fillsPerSec is the honest SUSTAINED rate — a post-knee burst-then-stall is NOT hidden", () => {
    // 4 matches land in a 3 s active burst, but the measurement window was 20 s: the sustained
    // rate is 0.2/s, NOT the 1.33/s burst rate. This is the knee-honesty property.
    const s = run().summary(20_000);
    expect(s.windowed).toBe(true);
    expect(s.windowMs).toBe(20_000);
    expect(s.fillsPerSec).toBeCloseTo(4 / 20, 6);
  });

  it("latency p50/p99 over open / close / combined samples", () => {
    const s = run().summary();
    // open |1050-1000|=50, |3030-3000|=30 → [30,50]; close |2080-2000|=80, |4120-4000|=120 → [80,120]; all [30,50,80,120]
    expect(s.latency).toMatchObject({ count: 4, openP50: 30, openP99: 50, closeP50: 80, closeP99: 120, p50: 50, p99: 120 });
  });

  it("fillsPerSecSeries zero-FILLS quiet buckets across the window so a stall is visible", () => {
    // matches at 1000,2000,3000,4000; window [0, 8000], 2 s buckets → [0:1(1000)?]. Use 1 s buckets over [0,5000].
    const series = run().fillsPerSecSeries(1000, { startMs: 0, endMs: 5000 });
    expect(series).toEqual([
      { bucketStartMs: 0, matches: 0, fillsPerSec: 0 },
      { bucketStartMs: 1000, matches: 1, fillsPerSec: 1 },
      { bucketStartMs: 2000, matches: 1, fillsPerSec: 1 },
      { bucketStartMs: 3000, matches: 1, fillsPerSec: 1 },
      { bucketStartMs: 4000, matches: 1, fillsPerSec: 1 },
      { bucketStartMs: 5000, matches: 0, fillsPerSec: 0 },  // the stall shows as a zero bucket
    ]);
    expect(() => run().fillsPerSecSeries(0)).toThrow(/BUCKET_MS_INVALID/);
  });

  it("without a window, fillsPerSecSeries spans first→last match (buckets with ≥1 match, zero-filled between)", () => {
    const series = run().fillsPerSecSeries(2000); // ats 1000..4000 → buckets 1000,3000
    expect(series).toEqual([
      { bucketStartMs: 1000, matches: 2, fillsPerSec: 1 },
      { bucketStartMs: 3000, matches: 2, fillsPerSec: 1 },
    ]);
  });

  it("addCampaign counts matches that OCCURRED, including an in-flight round's open cross (not COMPLETED-only)", () => {
    const completed = hedgedRound(1, "100", { srcAt: 1000, bOpenAt: 1050, closeSrcAt: 2000, aCloseAt: 2080 });
    // Round 2 still closing: its B_OPEN terminally filled (the open cross HAPPENED), close not yet.
    const inflight = round(2, [
      ord("A_OPEN", { filled: "100", createdAt: 2990 }), ord("B_OPEN", { filled: "100", createdAt: 3000 }),
    ], { sourceFilledAt: 3050, state: "B_CLOSE_MAKER" });
    const campaign = { groups: [{ id: "g", pairs: [{ id: "p", rounds: [completed, inflight] }] }] } as unknown as ExperimentCampaign;
    const m = new RunMetrics();
    m.addCampaign(campaign);
    expect(m.summary().matchedFills).toBe(3); // 2 (completed) + 1 (in-flight open cross)
  });

  it("aggregateCurve sorts per-N summaries into the fills/sec + p50/p99 vs N curve", () => {
    const summ = (fillsPerSec: number, p50: number, p99: number, matchedFills: number): RunSummary => ({
      matchedFills, filledLegs: matchedFills * 2, matchedBaseX18: "0", matchedQuoteX18: "0",
      rounds: matchedFills, hedgedRounds: matchedFills, spanMs: 1000, windowMs: 1000, windowed: true, fillsPerSec,
      latency: { count: matchedFills, openP50: p50, openP99: p99, closeP50: p50, closeP99: p99, p50, p99 },
    });
    const curve = aggregateCurve([
      { n: 10, summary: summ(40, 60, 120, 40) },
      { n: 1, summary: summ(5, 20, 35, 5) },
      { n: 4, summary: summ(18, 40, 90, 18) },
    ]);
    expect(curve.map((c) => c.n)).toEqual([1, 4, 10]);
    expect(curve[2]).toEqual({ n: 10, fillsPerSec: 40, matchedFills: 40, p50Ms: 60, p99Ms: 120 });
  });

  it("an empty run summarises to zeros without dividing by zero", () => {
    const s = new RunMetrics().summary();
    expect(s).toMatchObject({ matchedFills: 0, filledLegs: 0, spanMs: 0, fillsPerSec: 0 });
    expect(s.latency.count).toBe(0);
    expect(new RunMetrics().fillsPerSecSeries()).toEqual([]);
    // With an explicit window, an empty run still reports zero-filled buckets (an all-stall window).
    expect(new RunMetrics().fillsPerSecSeries(1000, { startMs: 0, endMs: 2000 })).toEqual([
      { bucketStartMs: 0, matches: 0, fillsPerSec: 0 },
      { bucketStartMs: 1000, matches: 0, fillsPerSec: 0 },
      { bucketStartMs: 2000, matches: 0, fillsPerSec: 0 },
    ]);
  });
});
