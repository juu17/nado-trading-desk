// Guards the STP own-conflict policy (B-2 / decision #2): the designed same-pair A↔B cross is
// PERMITTED (never flagged); only UNINTENDED cross-pair collisions are reported/cancelled, and
// `own_conflict_cancel` is exposed. Single market, many self-crossing pairs.
import { describe, expect, it } from "vitest";
import { OwnTradeRegistry, type RestingMaker, type ConflictCancelOutcome } from "./self-trade.js";

// A/B wallets per pair; prices are X18 integer strings. BTC ~ 50000e18 for readability we use
// small round integers — only the ordering matters.
const maker = (pairId: string, owner: string, side: "BUY" | "SELL", price: string, digest = `${pairId}:${owner}:${side}:${price}`): RestingMaker =>
  ({ digest, pairId, owner, side, priceX18: price });

describe("OwnTradeRegistry — STP own-conflict policy", () => {
  it("permits the designed same-pair A↔B cross: a pair's taker never conflicts with its own maker", () => {
    const r = new OwnTradeRegistry();
    // pair p1: A rests a BUY maker at 100; B will cross it with a SELL taker at 100.
    r.register(maker("p1", "A1", "BUY", "100"));
    const conflicts = r.conflicts({ pairId: "p1", side: "SELL", priceX18: "100" });
    expect(conflicts).toEqual([]);                                   // its own pair-mate is NOT a conflict
    expect(r.classifyCross("p1:A1:BUY:100", "p1")).toBe("intended"); // same pair ⇒ intended
  });

  it("flags an UNINTENDED cross-pair collision: a taker that would cross another pair's maker", () => {
    const r = new OwnTradeRegistry();
    r.register(maker("p1", "A1", "BUY", "100")); // p1's own resting maker (its pair-mate's target)
    r.register(maker("p2", "A2", "BUY", "100")); // p2's maker at the SAME price — a cross-pair collision
    // p1's B crosses with a SELL taker at 100: it must only hit p1's maker, not p2's.
    const conflicts = r.conflicts({ pairId: "p1", side: "SELL", priceX18: "100" });
    expect(conflicts.map((m) => m.pairId)).toEqual(["p2"]);          // only the OTHER pair's maker
    expect(r.classifyCross("p2:A2:BUY:100", "p1")).toBe("own-conflict");
  });

  it("only crosses the opposite side at a crossable price", () => {
    const r = new OwnTradeRegistry();
    r.register(maker("p2", "x", "SELL", "90"));  // ask below a BUY taker → crossed
    r.register(maker("p3", "y", "SELL", "120")); // ask above a BUY taker → NOT crossed
    r.register(maker("p4", "z", "BUY", "80"));   // same side as a BUY taker → never
    const conflicts = r.conflicts({ pairId: "p1", side: "BUY", priceX18: "100" });
    expect(conflicts.map((m) => m.pairId)).toEqual(["p2"]);
  });

  it("returns cross-pair conflicts worst-first (BUY taker: cheapest ask first; SELL taker: dearest bid first)", () => {
    const r = new OwnTradeRegistry();
    r.register(maker("p2", "x", "SELL", "95"));
    r.register(maker("p3", "y", "SELL", "90"));
    r.register(maker("p4", "z", "SELL", "99"));
    const buy = r.conflicts({ pairId: "p1", side: "BUY", priceX18: "100" });
    expect(buy.map((m) => m.priceX18)).toEqual(["90", "95", "99"]);  // cheapest ask first
    const r2 = new OwnTradeRegistry();
    r2.register(maker("p2", "x", "BUY", "105"));
    r2.register(maker("p3", "y", "BUY", "110"));
    const sell = r2.conflicts({ pairId: "p1", side: "SELL", priceX18: "100" });
    expect(sell.map((m) => m.priceX18)).toEqual(["110", "105"]);     // dearest bid first
  });

  it("stops tracking a released maker (terminal / cancelled / crossed)", () => {
    const r = new OwnTradeRegistry();
    r.register(maker("p2", "x", "SELL", "90", "d1"));
    expect(r.has("d1")).toBe(true);
    r.release("d1");
    expect(r.has("d1")).toBe(false);
    expect(r.conflicts({ pairId: "p1", side: "BUY", priceX18: "100" })).toEqual([]);
    expect(r.classifyCross("d1", "p1")).toBe("unknown");             // untracked ⇒ unknown
  });

  it("resolveConflicts cancels every cross-pair maker and counts own_conflict_cancel (noting fills)", async () => {
    const r = new OwnTradeRegistry();
    r.register(maker("p2", "x", "SELL", "95", "d2"));
    r.register(maker("p3", "y", "SELL", "90", "d3")); // this one had already (partly) filled
    const cancelled: string[] = [];
    const cancel = async (m: RestingMaker): Promise<ConflictCancelOutcome> => {
      cancelled.push(m.digest);
      return { removed: true, filled: m.digest === "d3" };
    };
    const n = await r.resolveConflicts({ pairId: "p1", side: "BUY", priceX18: "100" }, cancel);
    expect(n).toBe(2);
    expect(cancelled).toEqual(["d3", "d2"]);                         // worst-first order
    expect(r.size).toBe(0);                                         // both released
    expect(r.metrics()).toEqual({ ownConflictCancel: 2, ownConflictFilled: 1, restingMakers: 0 });
  });

  it("resolveConflicts leaves a maker the seam could not remove (not counted), and honours allowed()", async () => {
    const r = new OwnTradeRegistry();
    r.register(maker("p2", "x", "SELL", "90", "d2"));
    r.register(maker("p3", "y", "SELL", "95", "d3"));
    // seam cannot remove d2 (still resting / unknown): not counted, left tracked.
    const stuck = async (): Promise<ConflictCancelOutcome> => ({ removed: false, filled: false });
    expect(await r.resolveConflicts({ pairId: "p1", side: "BUY", priceX18: "100" }, stuck)).toBe(0);
    expect(r.size).toBe(2);
    expect(r.metrics().ownConflictCancel).toBe(0);
    // allowed() false stops before any cancel.
    let calls = 0;
    const count = async (): Promise<ConflictCancelOutcome> => { calls++; return { removed: true, filled: false }; };
    expect(await r.resolveConflicts({ pairId: "p1", side: "BUY", priceX18: "100" }, count, { allowed: () => false })).toBe(0);
    expect(calls).toBe(0);
  });

  it("rejects a malformed price/side so a bad maker can never mis-classify", () => {
    const r = new OwnTradeRegistry();
    for (const bad of ["", "   ", "1.5", "-5", "abc", "1,000", "0x1f"]) {
      expect(() => r.register(maker("p2", "x", "SELL", bad)), `price ${JSON.stringify(bad)}`).toThrow(/PRICE_INVALID/);
    }
    expect(() => r.register({ digest: "d", pairId: "p2", owner: "x", side: "BIDE" as never, priceX18: "90" })).toThrow(/MAKER_SIDE_INVALID/);
    r.register(maker("p2", "x", "SELL", "90"));
    expect(() => r.conflicts({ pairId: "p1", side: "BUY", priceX18: "oops" })).toThrow(/CANDIDATE_PRICE_INVALID/);
  });

  it("rejects a candidate with an empty pairId or bad side (the one caller bug that could flag the intended cross)", () => {
    const r = new OwnTradeRegistry();
    r.register(maker("p2", "x", "SELL", "90"));
    expect(() => r.conflicts({ pairId: "", side: "BUY", priceX18: "100" })).toThrow(/CANDIDATE_PAIR_REQUIRED/);
    expect(() => r.conflicts({ pairId: "p1", side: "UP" as never, priceX18: "100" })).toThrow(/CANDIDATE_SIDE_INVALID/);
  });

  it("does not double-count own_conflict_cancel when a maker is resolved concurrently (post-await recheck)", async () => {
    const r = new OwnTradeRegistry();
    r.register(maker("p2", "x", "SELL", "90", "d"));
    // Simulate another lane recording + releasing this exact maker DURING our await.
    const cancel = async (m: RestingMaker): Promise<ConflictCancelOutcome> => {
      r.recordConflictCancel(m.digest, false);
      return { removed: true, filled: false };
    };
    const n = await r.resolveConflicts({ pairId: "p1", side: "BUY", priceX18: "100" }, cancel);
    expect(n).toBe(0);                              // our lane saw it already gone after the await
    expect(r.metrics().ownConflictCancel).toBe(1); // counted exactly once
  });
});
