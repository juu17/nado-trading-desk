import { describe, it, expect } from "vitest";
import { FillHintRouter, InMemoryFillHintRegistry } from "./fill-hints.js";
import type { NudgeSink } from "./types.js";

function sink() {
  const calls: Array<[string, string]> = [];
  const nudge: NudgeSink = { nudge: (c, p) => { calls.push([c, p]); } };
  return { nudge, calls };
}

const A = "0x" + "1".repeat(40);

describe("FillHintRouter", () => {
  it("routes a known subaccount to nudge(campaign, pair)", () => {
    const reg = new InMemoryFillHintRegistry();
    reg.set(A, { campaignId: "c1", pairId: "p1" });
    const s = sink();
    new FillHintRouter(reg, s.nudge).onFill(A);
    expect(s.calls).toEqual([["c1", "p1"]]);
  });

  it("ignores an empty subaccount and an unknown subaccount", () => {
    const reg = new InMemoryFillHintRegistry();
    reg.set(A, { campaignId: "c1", pairId: "p1" });
    const s = sink();
    const r = new FillHintRouter(reg, s.nudge);
    r.onFill("");
    r.onFill("0x" + "2".repeat(40));
    expect(s.calls).toEqual([]);
  });

  it("folds subaccount case and stops routing after delete/clear", () => {
    const reg = new InMemoryFillHintRegistry();
    reg.set(A, { campaignId: "c1", pairId: "p1" });
    const s = sink();
    const r = new FillHintRouter(reg, s.nudge);
    r.onFill(A.toUpperCase()); // mixed case still resolves
    reg.delete(A);
    r.onFill(A);
    expect(s.calls).toEqual([["c1", "p1"]]);
    expect(reg.size).toBe(0);
  });

  it("swallows BOTH an async rejection AND a synchronous throw, reporting via onNudgeError", () => {
    const reg = new InMemoryFillHintRegistry();
    reg.set(A, { campaignId: "c1", pairId: "p1" });
    const errors: unknown[] = [];
    const asyncReject: NudgeSink = { nudge: () => Promise.reject(new Error("async boom")) };
    const syncThrow: NudgeSink = { nudge: () => { throw new Error("sync boom"); } };
    // sync throw must NOT escape onFill (the half-implemented swallow this guards against)
    expect(() => new FillHintRouter(reg, syncThrow, { onNudgeError: (e) => errors.push(e) }).onFill(A)).not.toThrow();
    expect(() => new FillHintRouter(reg, asyncReject, { onNudgeError: (e) => errors.push(e) }).onFill(A)).not.toThrow();
    // let the microtask-queued rejections settle, then assert both were reported
    return Promise.resolve().then(() => Promise.resolve()).then(() => {
      expect(errors).toHaveLength(2);
    });
  });
});
