// =============================================================================
// @farm/loadgen · ramp — the load driver (Phase B-4, decision #5). Sweeps the FREE
// `maxConcurrency` dial (decoupled from funding; not the intern's 1–5 batches × 10 cap) through
// step-and-hold / linear / spike profiles, and at each level measures the capacity readout, to
// plot fills/sec + p50/p99 latency vs N (decision #1).
//
// The dial is the campaign's `maxConcurrency`, which the coordinator reads every tick
// (coordinator.ts: `active >= (c.maxConcurrency ?? 1)`); the driver mutates it between levels
// through the store. Everything the driver needs from the engine/clock is injected, so the SAME
// driver runs the offline monkey Flow (fake connector + test clock — benchmark-flow.test.ts) and
// a live testnet run (real gateway + wall clock); the orchestration is unit-tested with mocks.
// =============================================================================
import type { ExperimentRound } from "@farm/core";
import { RunMetrics, aggregateCurve, type CurvePoint, type RunSummary } from "./metrics.js";

export type RampShape = "step" | "linear" | "spike";

export interface RampProfile {
  shape: RampShape;
  /** Starting (and, for spike, baseline/recovery) concurrency. ≥ 1. */
  startN: number;
  /** Peak concurrency. ≥ startN. */
  peakN: number;
  /** step: number of staircase levels from startN..peakN (≥ 1). Ignored by linear/spike. */
  levels?: number;
  /** Wall-clock ms held at each level. > 0. */
  holdMs: number;
  /** spike: ms held at the peak (defaults to holdMs). */
  spikeHoldMs?: number;
}

/** One concurrency setpoint: hold `n` pairs for `holdMs`, starting at `atMs` into the ramp. */
export interface RampSetpoint { atMs: number; n: number; holdMs: number }

export interface BenchmarkRun {
  profile: RampProfile;
  setpoints: RampSetpoint[];
  points: { n: number; summary: RunSummary }[];
  curve: CurvePoint[];
}

/**
 * Expand a profile into an ordered list of concurrency setpoints:
 *  • step  — a staircase of `levels` evenly-spaced steps from startN to peakN, each held holdMs
 *            (step-and-hold: let each level settle before stepping up).
 *  • linear— every integer N from startN to peakN, each held holdMs (a fine ramp).
 *  • spike — baseline startN (holdMs) → a spike to peakN (spikeHoldMs) → back to startN (holdMs),
 *            to probe how the engine absorbs a sudden admission burst and the sustained load after.
 *
 * ⚠️ The dial is an ADMISSION ceiling, and the base coordinator does NOT preempt already-active
 * pairs (and, on a reused cohort with an effectively-uncapped per-wallet target, pairs never
 * complete), so LOWERING the dial stops admitting NEW pairs but leaves the burst's pairs running.
 * The spike's down-leg therefore measures the post-burst SUSTAINED load at the peak-admitted
 * concurrency, not a concurrency reduction. A true concurrency-down (preempt/park active pairs
 * when the dial drops) is a coordinator change, deferred.
 */
export function rampSchedule(profile: RampProfile): RampSetpoint[] {
  const { shape, startN, peakN, holdMs } = profile;
  if (!Number.isInteger(startN) || startN < 1) throw new Error("RAMP_START_N_INVALID");
  if (!Number.isInteger(peakN) || peakN < startN) throw new Error("RAMP_PEAK_N_INVALID");
  if (!(holdMs > 0)) throw new Error("RAMP_HOLD_MS_INVALID");

  const ns: number[] = [];
  const holds: number[] = [];
  if (shape === "step") {
    const levels = profile.levels ?? 1;
    if (!Number.isInteger(levels) || levels < 1) throw new Error("RAMP_LEVELS_INVALID");
    for (let i = 0; i < levels; i++) {
      const n = levels === 1 ? startN : Math.round(startN + ((peakN - startN) * i) / (levels - 1));
      ns.push(Math.max(1, n)); holds.push(holdMs);
    }
  } else if (shape === "linear") {
    for (let n = startN; n <= peakN; n++) { ns.push(n); holds.push(holdMs); }
  } else {
    const spikeHoldMs = profile.spikeHoldMs ?? holdMs;
    if (!(spikeHoldMs > 0)) throw new Error("RAMP_SPIKE_HOLD_MS_INVALID");
    ns.push(startN, peakN, startN); holds.push(holdMs, spikeHoldMs, holdMs);
  }

  let atMs = 0;
  return ns.map((n, i) => { const sp = { atMs, n, holdMs: holds[i] as number }; atMs += holds[i] as number; return sp; });
}

export interface BenchmarkDriverDeps {
  /** Set the free concurrency dial for the coming ticks (mutate campaign.maxConcurrency via the store). */
  setConcurrency(n: number): Promise<void> | void;
  /** Advance the experiment one coordinator tick. */
  tick(): Promise<void> | void;
  /** Every round across the campaign (groups → pairs → rounds), for per-level attribution. */
  rounds(): Promise<readonly ExperimentRound[]> | readonly ExperimentRound[];
  /** Current clock (ms). */
  now(): number;
  /** Advance the clock by `ms` (a test clock) or wait that long (a live run). */
  advance(ms: number): Promise<void> | void;
  /** Clock advance per tick (ms, > 0). A level runs until its holdMs of clock has elapsed. */
  tickMs: number;
}

/**
 * Drives a ramp over the coordinator and records a curve point per level. Each level: set the
 * dial, tick while advancing the clock across the level's window, then summarise the matches that
 * FIRED in that window — attributed by match timestamp (atMs), not by which level minted the
 * round, so the coordinator pre-minting the next round at a level boundary neither loses nor
 * double-counts a cross — and anchored to the window (so a post-knee stall reports its true
 * sustained rate, not a burst rate).
 */
export class BenchmarkDriver {
  constructor(private readonly deps: BenchmarkDriverDeps) {
    if (!(deps.tickMs > 0)) throw new Error("RAMP_TICK_MS_INVALID");
  }

  /** Run one level and summarise the matches whose atMs falls in its window. `window` sets the
   *  exact (schedule-anchored, contiguous) measurement window; omitted, it is [now, now+holdMs). */
  async runLevel(setpoint: RampSetpoint, window?: { startMs: number; endMs: number }): Promise<{ n: number; summary: RunSummary }> {
    await this.deps.setConcurrency(setpoint.n);
    const startMs = window?.startMs ?? this.deps.now();
    const endMs = window?.endMs ?? startMs + setpoint.holdMs;
    while (this.deps.now() < endMs) {
      await this.deps.tick();
      await this.deps.advance(this.deps.tickMs);
    }
    const metrics = new RunMetrics();
    for (const r of await this.deps.rounds()) if (r.orders.length > 0) metrics.addRound(r);
    return { n: setpoint.n, summary: metrics.summary(setpoint.holdMs, { startMs, endMs }) };
  }

  async runCurve(profile: RampProfile): Promise<BenchmarkRun> {
    const setpoints = rampSchedule(profile);
    const runStart = this.deps.now();
    const points: { n: number; summary: RunSummary }[] = [];
    // Exact, contiguous windows anchored to the schedule (runStart + cumulative atMs), so every
    // match is filed into exactly one level by its atMs regardless of clock-advance drift.
    for (const sp of setpoints) {
      const startMs = runStart + sp.atMs, endMs = startMs + sp.holdMs;
      points.push(await this.runLevel(sp, { startMs, endMs }));
    }
    return { profile, setpoints, points, curve: aggregateCurve(points) };
  }
}
