// Guards the ramp driver (B-4 / decision #5): step-and-hold / linear / spike schedules over the
// free maxConcurrency dial, and the BenchmarkDriver orchestration (set dial → tick across the
// level window → window-anchored summary per level → curve). Orchestration is tested with mock
// deps; the full-pipeline end-to-end run is benchmark-flow.test.ts.
import { describe, expect, it } from "vitest";
import type { ExperimentOrder, ExperimentRound } from "@farm/core";
import { rampSchedule, BenchmarkDriver, type RampSetpoint } from "./ramp.js";

describe("rampSchedule", () => {
  it("step: a staircase of evenly-spaced levels from startN to peakN, each held holdMs", () => {
    const s = rampSchedule({ shape: "step", startN: 1, peakN: 16, levels: 4, holdMs: 1000 });
    expect(s.map((p) => p.n)).toEqual([1, 6, 11, 16]);
    expect(s.map((p) => p.atMs)).toEqual([0, 1000, 2000, 3000]);
    expect(s.every((p) => p.holdMs === 1000)).toBe(true);
  });

  it("step with 1 level is just startN; peakN==startN holds flat", () => {
    expect(rampSchedule({ shape: "step", startN: 5, peakN: 20, levels: 1, holdMs: 10 }).map((p) => p.n)).toEqual([5]);
    expect(rampSchedule({ shape: "step", startN: 3, peakN: 3, levels: 3, holdMs: 10 }).map((p) => p.n)).toEqual([3, 3, 3]);
  });

  it("linear: every integer N from startN to peakN", () => {
    const s = rampSchedule({ shape: "linear", startN: 2, peakN: 6, holdMs: 500 });
    expect(s.map((p) => p.n)).toEqual([2, 3, 4, 5, 6]);
    expect(s.map((p) => p.atMs)).toEqual([0, 500, 1000, 1500, 2000]);
  });

  it("spike: baseline → peak → baseline, peak held spikeHoldMs", () => {
    const s = rampSchedule({ shape: "spike", startN: 2, peakN: 50, holdMs: 1000, spikeHoldMs: 300 });
    expect(s.map((p) => p.n)).toEqual([2, 50, 2]);
    expect(s.map((p) => p.holdMs)).toEqual([1000, 300, 1000]);
    expect(s.map((p) => p.atMs)).toEqual([0, 1000, 1300]);
  });

  it("rejects invalid shapes/params", () => {
    expect(() => rampSchedule({ shape: "step", startN: 0, peakN: 4, holdMs: 1 })).toThrow(/START_N/);
    expect(() => rampSchedule({ shape: "step", startN: 5, peakN: 4, holdMs: 1 })).toThrow(/PEAK_N/);
    expect(() => rampSchedule({ shape: "linear", startN: 1, peakN: 4, holdMs: 0 })).toThrow(/HOLD_MS/);
    expect(() => rampSchedule({ shape: "step", startN: 1, peakN: 4, levels: 0, holdMs: 1 })).toThrow(/LEVELS/);
  });
});

// A mock harness: a controllable clock, a dial the driver sets, and a round "factory" that
// mints one completed hedged round per pair per tick while the clock advances — enough to
// exercise runLevel attribution (new rounds this level) + window-anchored summary.
function mockHarness() {
  let now = 0;
  let dial = 1;
  const rounds: ExperimentRound[] = [];
  let seq = 0;
  const ord = (role: ExperimentOrder["role"], at: number): ExperimentOrder => ({
    id: `o${seq}:${role}`, role, state: "TERMINAL", createdAt: at, filledX18: "100", quoteFilledX18: "100", feePaidX18: "0",
    mode: "SIMULATION", chainId: 763373, owner: "0x", productId: 2, digest: "0x", payload: "{}",
    quantityX18: "100", priceX18: "0", nonce: "1", expiration: 0, side: "BUY", reduceOnly: false, postOnly: false, epoch: 0, factKnown: true,
  }) as ExperimentOrder;
  const tick = () => {
    // One hedged round per active pair (bounded by the dial) per tick, stamped at `now`.
    for (let p = 0; p < dial; p++) {
      const id = `r${seq++}`;
      rounds.push({ id, number: seq, openAt: now, side: "BUY", holdMs: 0, state: "COMPLETED",
        sourceFilledAt: now, closeSourceFilledAt: now + 5,
        orders: [ord("A_OPEN", now - 1), ord("B_OPEN", now + 2), ord("B_CLOSE", now + 4), ord("A_CLOSE", now + 7)],
      } as ExperimentRound);
    }
  };
  return {
    deps: {
      setConcurrency: (n: number) => { dial = n; },
      tick,
      rounds: () => rounds,
      now: () => now,
      advance: (ms: number) => { now += ms; },
      tickMs: 100,
    },
    get dial() { return dial; },
    get roundCount() { return rounds.length; },
  };
}

describe("BenchmarkDriver", () => {
  it("rejects a non-positive tickMs", () => {
    expect(() => new BenchmarkDriver({ ...mockHarness().deps, tickMs: 0 })).toThrow(/TICK_MS/);
  });

  it("runLevel sets the dial, ticks across the window, and summarises that level's matches (window-anchored)", async () => {
    const h = mockHarness();
    const driver = new BenchmarkDriver(h.deps);
    const sp: RampSetpoint = { atMs: 0, n: 3, holdMs: 1000 }; // 1000/100 = 10 ticks, 3 pairs/tick = 30 rounds
    const { n, summary } = await driver.runLevel(sp);
    expect(n).toBe(3);
    expect(h.dial).toBe(3);                               // the free dial was set
    expect(summary.rounds).toBe(30);                      // 10 ticks × 3 pairs
    expect(summary.matchedFills).toBe(60);                // 2 taker crosses per hedged round
    expect(summary.windowed).toBe(true);
    expect(summary.windowMs).toBe(1000);
    expect(summary.fillsPerSec).toBeCloseTo(60 / 1, 6);   // 60 matches / 1 s window
  });

  it("runCurve walks the profile, attributing each level only the matches whose atMs fall in its window", async () => {
    const h = mockHarness();
    const run = await new BenchmarkDriver(h.deps).runCurve({ shape: "step", startN: 1, peakN: 3, levels: 3, holdMs: 500 });
    expect(run.setpoints.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(run.curve.map((c) => c.n)).toEqual([1, 2, 3]);
    // Each level: holdMs/tickMs = 5 ticks × n pairs rounds, each round = 2 matches.
    expect(run.points.map((p) => p.summary.matchedFills)).toEqual([5 * 1 * 2, 5 * 2 * 2, 5 * 3 * 2]); // [10,20,30]
    // fills/sec rises with N (the curve the driver exists to plot).
    const fps = run.curve.map((c) => c.fillsPerSec);
    expect(fps[0]!).toBeLessThan(fps[1]!);
    expect(fps[1]!).toBeLessThan(fps[2]!);
  });
});
