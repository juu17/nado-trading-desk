// Offline gate for the stray-fill CIRCUIT-BREAKER + the transient-UNKNOWN abort grace (M0 §3.4).
// Hand-built rounds drive the classifier; no network, no funds. Proves: a clean A↔B cross and an
// empty skip are NOT strays; one-sided / partial-cross rounds ARE; strays are counted once (by id)
// and only when the round is COMPLETED (a still-cross-ing / UNKNOWN round is never counted — that
// is the abort gate's job); the breaker trips once on the count OR the cost cap; and the grace
// aborts a transient UNKNOWN only after it persists past the window, resetting when it clears.
import { describe, expect, it, vi } from "vitest";
import type { ExperimentOrder, ExperimentRound } from "@farm/core";
import { StrayGuard, AbortGrace, classifyStray, roundCostX18 } from "./stray-guard.js";

const x18 = (n: number) => (BigInt(n) * 10n ** 18n).toString();
const order = (role: string, filledX18: string, state: ExperimentOrder["state"] = "TERMINAL"): ExperimentOrder =>
  ({ role, state, filledX18 } as unknown as ExperimentOrder);

function round(id: string, over: Partial<ExperimentRound> & { orders: ExperimentOrder[] }): ExperimentRound {
  return { id, number: 1, openAt: 0, side: "BUY", holdMs: 0, state: "COMPLETED", ...over } as ExperimentRound;
}
const clean = (id: string) => round(id, { orders: [order("A_OPEN", x18(1)), order("B_OPEN", x18(1))], result: { aPnlX18: "-" + x18(0), bPnlX18: "-1" } as never });
const skip = (id: string) => round(id, { orders: [], earlyExitReason: "REPRICE_EXHAUSTED_EXIT" });
const sweep = (id: string, lossX18 = "1") => round(id, { orders: [order("A_OPEN", "0"), order("B_OPEN", x18(1)), order("B_CLOSE", x18(1))], earlyExitReason: "FOLLOW_TIMEOUT_EXIT", result: { aPnlX18: "0", bPnlX18: "-" + lossX18 } as never });
const makerHit = (id: string) => round(id, { orders: [order("A_OPEN", x18(1)), order("B_OPEN", "0"), order("A_CLOSE", x18(1))], earlyExitReason: "FOLLOWER_INCOMPLETE_EXIT", result: { aPnlX18: "-1", bPnlX18: "0" } as never });

describe("classifyStray / roundCostX18", () => {
  it("a clean A↔B cross (A_OPEN filled == B_OPEN filled) is NOT a stray", () => {
    expect(classifyStray(clean("r1"))).toBeUndefined();
  });
  it("an empty skip (nothing filled) is NOT a stray", () => {
    expect(classifyStray(skip("r1"))).toBeUndefined();
  });
  it("B swept external (A_OPEN filled 0, B_OPEN filled) is an external-sweep stray", () => {
    expect(classifyStray(sweep("r1"))).toMatchObject({ kind: "external-sweep" });
  });
  it("A hit by a stranger (A_OPEN filled, B_OPEN filled 0) is a maker-hit stray", () => {
    expect(classifyStray(makerHit("r1"))).toMatchObject({ kind: "maker-hit" });
  });
  it("a partial cross (both filled, unequal) is a partial-cross stray", () => {
    const r = round("r1", { orders: [order("A_OPEN", x18(2)), order("B_OPEN", x18(1))], earlyExitReason: "FOLLOWER_INCOMPLETE_EXIT" });
    expect(classifyStray(r)).toMatchObject({ kind: "partial-cross" });
  });
  it("a non-COMPLETED round is never classified (the abort gate owns in-flight / UNKNOWN rounds)", () => {
    const r = round("r1", { state: "B_OPEN", orders: [order("A_OPEN", "0"), order("B_OPEN", x18(1))] });
    expect(classifyStray(r)).toBeUndefined();
  });
  it("roundCostX18 is the non-negative net loss; a gain is zero cost; absent result is zero", () => {
    expect(roundCostX18(round("r", { orders: [], result: { aPnlX18: "-3", bPnlX18: "-2" } as never }))).toBe(5n);
    expect(roundCostX18(round("r", { orders: [], result: { aPnlX18: "10", bPnlX18: "-2" } as never }))).toBe(0n);
    expect(roundCostX18(round("r", { orders: [] }))).toBe(0n);
  });
});

describe("StrayGuard circuit-breaker", () => {
  it("counts each stray once (by id) and ignores clean / skip / unsettled rounds", async () => {
    const g = new StrayGuard({ onTrip: vi.fn() });
    await g.scan([clean("c1"), skip("s1"), sweep("x1", "2")]);
    await g.scan([clean("c1"), skip("s1"), sweep("x1", "2"), makerHit("m1")]); // x1 already counted
    expect(g.strayCount).toBe(2);               // x1 + m1
    expect(g.cumulativeCostX18).toBe(2n + 1n);  // sweep loss 2 + makerHit loss 1
  });

  it("trips once on the COUNT cap (count cap is primary)", async () => {
    const onTrip = vi.fn();
    const g = new StrayGuard({ stopCount: 1, onTrip });
    await g.scan([sweep("x1")]);                 // count 1, not > 1
    expect(g.tripped).toBe(false);
    const b = await g.scan([sweep("x1"), sweep("x2")]); // count 2 > 1 → trip
    expect(b.tripped).toBe(true); expect(b.reason).toBe("count");
    await g.scan([sweep("x1"), sweep("x2"), sweep("x3")]); // no re-fire
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it("trips on the COST cap (half-the-global-stop backstop) when the count cap is generous", async () => {
    const onTrip = vi.fn();
    const g = new StrayGuard({ stopCount: 100, stopCostX18: 5n, onTrip });
    await g.scan([sweep("x1", "4")]);            // cost 4, not > 5
    expect(g.tripped).toBe(false);
    const b = await g.scan([sweep("x1", "4"), sweep("x2", "3")]); // cost 7 > 5 → trip
    expect(b.tripped).toBe(true); expect(b.reason).toBe("cost");
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it("never trips with no caps configured (OFF by default — testnet/offline)", async () => {
    const onTrip = vi.fn();
    const g = new StrayGuard({ onTrip });
    await g.scan([sweep("x1"), sweep("x2"), sweep("x3"), makerHit("m1")]);
    expect(g.strayCount).toBe(4); expect(g.tripped).toBe(false);
    expect(onTrip).not.toHaveBeenCalled();
  });
});

describe("AbortGrace (bounded let-the-coordinator-resolve window for transient UNKNOWN)", () => {
  it("does not abort while the UNKNOWN is within the grace window", () => {
    let clock = 1000;
    const grace = new AbortGrace({ graceMs: 3000, now: () => clock });
    expect(grace.observe("order UNKNOWN")).toBeUndefined(); // t=1000, window starts
    clock = 3000;
    expect(grace.observe("order UNKNOWN")).toBeUndefined(); // 2000ms < 3000ms grace
    expect(grace.pending).toBe(true);
  });
  it("aborts once the UNKNOWN has persisted past the grace", () => {
    let clock = 1000;
    const grace = new AbortGrace({ graceMs: 3000, now: () => clock });
    grace.observe("order UNKNOWN");
    clock = 4000; // 3000ms elapsed
    expect(grace.observe("order UNKNOWN")).toBe("order UNKNOWN");
  });
  it("resets the window when the UNKNOWN clears (the coordinator self-resolved → continue)", () => {
    let clock = 1000;
    const grace = new AbortGrace({ graceMs: 3000, now: () => clock });
    grace.observe("order UNKNOWN");
    clock = 2500; expect(grace.observe(undefined)).toBeUndefined(); // cleared → reset
    expect(grace.pending).toBe(false);
    clock = 2600; expect(grace.observe("order UNKNOWN")).toBeUndefined(); // fresh window
    clock = 10000; expect(grace.observe("order UNKNOWN")).toBe("order UNKNOWN"); // now persisted
  });
});
