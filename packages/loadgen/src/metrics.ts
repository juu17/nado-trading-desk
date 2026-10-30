// =============================================================================
// @farm/loadgen · metrics — the capacity readout (Phase B-3, decision #1). The headline the
// benchmark exists to produce: MATCHED FILLS/SEC and the p50/p99 fill↔follow LATENCY, plotted
// as a CURVE vs N concurrent pairs.
//
// What a "matched fill" is (defined precisely so the number is unambiguous): one engine MATCH —
// a taker crossing resting liquidity. In the A/B self-cross loop the takers are B_OPEN (crosses
// A's resting open maker) and A_CLOSE (crosses B's resting close maker), so a fully-hedged round
// produces TWO matches. We count the TERMINAL-filled TAKER legs — each a distinct cross the
// engine executed (a leg that partial-fills then completes via a SECOND taker order counts as
// two crosses, with the base summed), never double-counting the maker side of a cross. We also
// report `filledLegs` (all filled legs, maker + taker) and matched base/quote.
//
// SINGLE-EGRESS OBSERVABLE rate (honest framing, decision #6): a match's timestamp is when its
// fill was first SEEN (round.sourceFilledAt / closeSourceFilledAt), i.e. observed through the
// shared single-IP read budget. So `fillsPerSec` is the matched-fill rate REACHABLE FROM ONE
// EGRESS — which is exactly the capacity decision #6 defines, read-pacing included — not an
// idealized engine-internal rate. `fillsPerSec` is anchored to the measurement WINDOW the driver
// passes (matchedFills / windowSeconds), NOT the match span: a choked run past the knee emits a
// dense burst then stalls, and only a window denominator (with zero-filled quiet buckets) reports
// that collapse honestly instead of hiding it as a high burst rate.
//
// The LATENCY is the one-sided-exposure magnitude per cross: |taker.createdAt − fill-seen|. In
// the ORGANIC model (fill seen first, then the follow is signed) that equals the intern cost.ts
// `followMs`/`closeFollowMs`. Under the locked SELF-CROSS default (decision #2) the taker is
// SIGNED BEFORE its own fill is seen (the taker is what fills the resting maker), so cost.ts's
// follow delay is degenerate (≈0 / omitted) there; the magnitude instead measures the engine
// fill-CONFIRM latency (signed → fill observed), which is the signal that grows at the knee. One
// run uses one mechanism, so the samples are a coherent class. The cost GATE stays OFF (it
// throttles load); cost ACCOUNTING is the coordinator's separate campaign.costs, untouched here.
//
// Pure + deterministic: everything is derived from ExperimentRounds, so it is unit-tested with
// hand-built rounds. The B-4 driver feeds a window's rounds in and records a curve point per N.
// =============================================================================
import type { ExperimentCampaign, ExperimentOrder, ExperimentRound } from "@farm/core";

/** One engine match (a taker cross), extracted from a round. */
export interface MatchEvent {
  roundId: string;
  roundNumber: number;
  leg: "open" | "close";
  /** Single-egress OBSERVED time of the cross: when its fill was first seen
   *  (round.sourceFilledAt / closeSourceFilledAt). Falls back to the taker's createdAt only when
   *  the fill-seen time was not recorded. */
  atMs: number;
  /** Matched base qty (the taker leg's cumulative filled), X18 decimal-integer string. */
  baseX18: string;
  /** Matched quote / turnover (the taker leg's filled quote), X18 decimal-integer string. */
  quoteX18: string;
  /** One-sided-exposure magnitude |taker.createdAt − fill-seen| (ms): the cost.ts followMs in the
   *  organic model, the engine fill-confirm latency under self-cross. Undefined when the fill-seen
   *  time was not recorded (then atMs falls back to createdAt and latency is unknown). */
  latencyMs?: number;
}

export interface RoundMetrics {
  matches: MatchEvent[];
  /** Count of TERMINAL legs with a positive fill (maker + taker). */
  filledLegs: number;
  /** A fully-hedged round: A_OPEN, B_OPEN, A_CLOSE, B_CLOSE all filled the same positive qty. */
  hedged: boolean;
}

export interface LatencySummary {
  /** Number of latency samples (matches whose fill-seen time was recorded). */
  count: number;
  openP50: number; openP99: number;
  closeP50: number; closeP99: number;
  /** Over open + close samples together. */
  p50: number; p99: number;
}

export interface RunSummary {
  /** Engine matches = terminal-filled taker crosses (the headline count). */
  matchedFills: number;
  /** Every TERMINAL leg that filled (maker + taker). */
  filledLegs: number;
  matchedBaseX18: string;
  matchedQuoteX18: string;
  rounds: number;
  hedgedRounds: number;
  /** First→last match wall-clock span (ms) — the active burst span. */
  spanMs: number;
  /** Denominator used for fillsPerSec: the driver-provided measurement window when given, else
   *  the match span (a burst-rate approximation). */
  windowMs: number;
  /** True when an explicit measurement window was supplied → fillsPerSec is the honest SUSTAINED
   *  rate; false → it is the match-span burst approximation (over-states a choked run). */
  windowed: boolean;
  /** matchedFills / (windowMs/1000). */
  fillsPerSec: number;
  latency: LatencySummary;
}

export interface FillsPerSecBucket { bucketStartMs: number; matches: number; fillsPerSec: number }

/** One point of the capacity curve: the sustained readout at a fixed concurrency N. */
export interface CurvePoint {
  n: number;
  fillsPerSec: number;
  matchedFills: number;
  p50Ms: number;
  p99Ms: number;
}

const TAKER_LEG: Record<"open" | "close", ExperimentOrder["role"]> = { open: "B_OPEN", close: "A_CLOSE" };

function bi(x: string): bigint { try { return BigInt(x); } catch { return 0n; } }
const isTerminalFilled = (o: ExperimentOrder): boolean => o.state === "TERMINAL" && bi(o.filledX18) > 0n;
const minOf = (xs: readonly number[]): number => xs.reduce((m, x) => (x < m ? x : m), xs[0] as number);
const maxOf = (xs: readonly number[]): number => xs.reduce((m, x) => (x > m ? x : m), xs[0] as number);

/** Nearest-rank percentile (p in [0,100]) of an ASCENDING-sorted sample array; 0 for empty.
 *  NOTE: nearest-rank → for fewer than 100 samples p99 is simply the worst sample; read the
 *  curve's p99 at low per-N match counts accordingly. */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx] as number;
}

/** Extract the match events (+ filled-leg count, hedged flag) from ONE round. A round need not be
 *  COMPLETED: a cross is counted once its taker leg is TERMINAL+filled (the match really happened,
 *  even if the round is still closing) — so an in-flight round's open cross is not lost. */
export function extractRoundMetrics(round: ExperimentRound): RoundMetrics {
  const matches: MatchEvent[] = [];
  const legMatches = (leg: "open" | "close", seenAt: number | undefined): void => {
    // filter (not find): a leg that executed via MULTIPLE taker orders (a partial IOC then a
    // second) is MULTIPLE engine crosses — count each, sum the base. Common case = one order.
    for (const taker of round.orders.filter((o) => o.role === TAKER_LEG[leg] && isTerminalFilled(o))) {
      matches.push({
        roundId: round.id, roundNumber: round.number, leg, atMs: seenAt ?? taker.createdAt,
        baseX18: String(bi(taker.filledX18)), quoteX18: String(bi(taker.quoteFilledX18)),
        // one-sided-exposure magnitude; only when the fill-seen time was recorded.
        ...(seenAt !== undefined ? { latencyMs: Math.abs(taker.createdAt - seenAt) } : {}),
      });
    }
  };
  legMatches("open", round.sourceFilledAt);
  legMatches("close", round.closeSourceFilledAt);

  const filledLegs = round.orders.filter(isTerminalFilled).length;
  const qty = (role: ExperimentOrder["role"]): bigint =>
    round.orders.filter((o) => o.role === role && o.state === "TERMINAL").reduce((n, o) => n + bi(o.filledX18), 0n);
  const opened = qty("A_OPEN");
  const hedged = opened > 0n && qty("B_OPEN") === opened && qty("A_CLOSE") === opened && qty("B_CLOSE") === opened;
  return { matches, filledLegs, hedged };
}

/**
 * Accumulates matches across the rounds of a measurement window into the capacity readout. Feed
 * it the window's rounds (`addRound`/`addRounds`) or a whole campaign (`addCampaign`); read
 * `summary(windowMs)` for the headline — pass the window's wall-clock duration so fillsPerSec is
 * the honest sustained rate — and `fillsPerSecSeries(bucketMs, window)` for the zero-filled
 * timeseries. One instance per concurrency level N.
 */
export class RunMetrics {
  private readonly events: MatchEvent[] = [];
  private readonly roundInfo = new Map<string, { hedged: boolean; filledLegs: number }>();
  private filledLegs = 0;
  private rounds = 0;
  private hedgedRounds = 0;

  addRound(round: ExperimentRound): void {
    const m = extractRoundMetrics(round);
    this.events.push(...m.matches);
    this.roundInfo.set(round.id, { hedged: m.hedged, filledLegs: m.filledLegs });
    this.filledLegs += m.filledLegs;
    this.rounds += 1;
    if (m.hedged) this.hedgedRounds += 1;
  }

  addRounds(rounds: readonly ExperimentRound[]): void { for (const r of rounds) this.addRound(r); }

  /** Walk a campaign's groups → pairs → rounds and add every STARTED round (one with orders).
   *  Counts matches that occurred in the window regardless of whether the round has completed, so
   *  a high-N cutoff with many rounds mid-close does not drop their already-executed open crosses. */
  addCampaign(campaign: ExperimentCampaign): void {
    for (const g of campaign.groups) for (const p of g.pairs) for (const r of p.rounds) {
      if (r.orders.length > 0) this.addRound(r);
    }
  }

  get matchCount(): number { return this.events.length; }

  /** The headline readout. Pass `windowMs` (the measurement window's wall-clock duration) for the
   *  honest SUSTAINED rate; omit it only for a quick burst-rate approximation (over-states a run
   *  that stalled after the knee). Pass `timeWindow` to attribute by MATCH TIMESTAMP: only matches
   *  whose atMs ∈ [startMs, endMs) count — the correct way to assign a cross to a concurrency
   *  level, robust to the coordinator pre-minting the next round at a level boundary (a round
   *  minted under level K but FIRING in K+1's window is filed into K+1 by its atMs, never lost or
   *  double-counted). windowMs then defaults to the window's own duration. */
  summary(windowMs?: number, timeWindow?: { startMs: number; endMs: number }): RunSummary {
    const ev = timeWindow ? this.events.filter((e) => e.atMs >= timeWindow.startMs && e.atMs < timeWindow.endMs) : this.events;
    const ats = ev.map((e) => e.atMs);
    const spanMs = ats.length > 1 ? maxOf(ats) - minOf(ats) : 0;
    const explicitWindow = windowMs !== undefined && windowMs > 0;
    const denomMs = explicitWindow ? windowMs : timeWindow ? timeWindow.endMs - timeWindow.startMs : spanMs;
    const windowed = explicitWindow || timeWindow !== undefined;
    const matchedFills = ev.length;
    const fillsPerSec = denomMs > 0 ? matchedFills / (denomMs / 1000) : matchedFills;
    const sum = (f: (e: MatchEvent) => bigint): string => String(ev.reduce((n, e) => n + f(e), 0n));
    // Round-level context: whole-collection counters for a non-time-windowed summary; for a time
    // window, the rounds whose matches fell in it (filledLegs of a boundary-straddling round may
    // be attributed to both windows it touches — context only, not the headline).
    let rounds = this.rounds, hedgedRounds = this.hedgedRounds, filledLegs = this.filledLegs;
    if (timeWindow) {
      const ids = new Set(ev.map((e) => e.roundId));
      rounds = ids.size; hedgedRounds = 0; filledLegs = 0;
      for (const id of ids) { const info = this.roundInfo.get(id); if (info) { if (info.hedged) hedgedRounds++; filledLegs += info.filledLegs; } }
    }
    const lat = (leg: "open" | "close"): number[] =>
      ev.filter((e) => e.leg === leg && e.latencyMs !== undefined).map((e) => e.latencyMs as number).sort((a, b) => a - b);
    const open = lat("open"), close = lat("close"), all = [...open, ...close].sort((a, b) => a - b);
    return {
      matchedFills, filledLegs,
      matchedBaseX18: sum((e) => bi(e.baseX18)), matchedQuoteX18: sum((e) => bi(e.quoteX18)),
      rounds, hedgedRounds, spanMs, windowMs: denomMs, windowed, fillsPerSec,
      latency: {
        count: all.length,
        openP50: percentile(open, 50), openP99: percentile(open, 99),
        closeP50: percentile(close, 50), closeP99: percentile(close, 99),
        p50: percentile(all, 50), p99: percentile(all, 99),
      },
    };
  }

  /** Matches bucketed into fixed wall-clock windows (default 1 s), each with its fills/sec. Pass
   *  `window` to zero-FILL the quiet buckets across the whole measurement window — without it a
   *  stall is invisible (only buckets holding a match appear), which hides a post-knee collapse. */
  fillsPerSecSeries(bucketMs = 1000, window?: { startMs: number; endMs: number }): FillsPerSecBucket[] {
    if (bucketMs <= 0) throw new Error("METRICS_BUCKET_MS_INVALID");
    const ats = this.events.map((e) => e.atMs);
    if (ats.length === 0 && !window) return [];
    const startMs = window ? window.startMs : minOf(ats);
    const endMs = window ? window.endMs : maxOf(ats);
    if (endMs < startMs) throw new Error("METRICS_WINDOW_INVALID");
    const counts = new Map<number, number>();
    for (const at of ats) {
      const bucket = startMs + Math.floor((at - startMs) / bucketMs) * bucketMs;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    const out: FillsPerSecBucket[] = [];
    for (let b = startMs; b <= endMs; b += bucketMs) {
      const matches = counts.get(b) ?? 0;
      out.push({ bucketStartMs: b, matches, fillsPerSec: matches / (bucketMs / 1000) });
    }
    return out;
  }
}

/** Build the capacity curve from the per-N measurements (one window-anchored RunSummary per
 *  concurrency level — call summary(windowMs) so each fillsPerSec is a sustained rate), sorted by
 *  N ascending. This is the decision-#1 headline: fills/sec + p50/p99 vs N pairs. */
export function aggregateCurve(points: readonly { n: number; summary: RunSummary }[]): CurvePoint[] {
  return points.map(({ n, summary }) => ({
    n, fillsPerSec: summary.fillsPerSec, matchedFills: summary.matchedFills,
    p50Ms: summary.latency.p50, p99Ms: summary.latency.p99,
  })).sort((a, b) => a.n - b.n);
}
