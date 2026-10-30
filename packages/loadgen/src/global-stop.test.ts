// Offline gate for the GLOBAL net-loss stop (the real-funds "$25" backstop). No network, no
// funds: a fake cohort-equity sequence drives the guard. Proves the baseline capture, the
// one-shot trip at the threshold, OFF-by-default behaviour, the read throttle, and that an
// unreadable wallet equity propagates (never a silent "no loss").
import { describe, expect, it, vi } from "vitest";
import type { EquitySource } from "./experiment-connector.js";
import { GlobalNetLossStop, cohortEquityReader } from "./global-stop.js";

const x18 = (n: number) => BigInt(n) * 10n ** 18n;

/** A cohort-equity source that yields the next value from a scripted sequence on each call. */
function sequence(values: bigint[]) {
  let i = 0;
  return async () => values[Math.min(i++, values.length - 1)]!;
}

describe("GlobalNetLossStop", () => {
  it("captures the baseline on the first check and measures the drop", async () => {
    const onStop = vi.fn();
    const stop = new GlobalNetLossStop({ cohortEquityX18: sequence([x18(100), x18(97), x18(90)]), stopX18: x18(25), onStop });
    const a = await stop.check();
    expect(a.baselineX18).toBe(x18(100)); expect(a.dropX18).toBe(0n); expect(a.tripped).toBe(false);
    const b = await stop.check();
    expect(b.dropX18).toBe(x18(3)); expect(b.tripped).toBe(false);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("fires onStop exactly once when the drop first reaches the stop, then latches", async () => {
    const onStop = vi.fn();
    // 100 -> 80 (drop 20, below 25) -> 74 (drop 26, >= 25 TRIP) -> 70 (already fired)
    const stop = new GlobalNetLossStop({ cohortEquityX18: sequence([x18(100), x18(80), x18(74), x18(70)]), stopX18: x18(25), onStop });
    await stop.check(); // baseline 100
    const below = await stop.check(); // drop 20
    expect(below.tripped).toBe(false); expect(stop.stopped).toBe(false);
    const trip = await stop.check(); // drop 26 >= 25
    expect(trip.tripped).toBe(true); expect(trip.dropX18).toBe(x18(26)); expect(stop.stopped).toBe(true);
    await stop.check(); // further loss — does NOT re-fire
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith(expect.objectContaining({ tripped: true, dropX18: x18(26) }));
  });

  it("is OFF (never trips) when no stop is configured — the generous default", async () => {
    const onStop = vi.fn();
    const stop = new GlobalNetLossStop({ cohortEquityX18: sequence([x18(100), x18(1)]), onStop }); // stopX18 undefined
    await stop.check();
    const big = await stop.check();
    expect(big.armed).toBe(false); expect(big.dropX18).toBe(x18(99)); expect(big.tripped).toBe(false);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("is OFF when the stop is <= 0", async () => {
    const stop = new GlobalNetLossStop({ cohortEquityX18: sequence([x18(100), x18(1)]), stopX18: 0n, onStop: vi.fn() });
    await stop.check();
    expect((await stop.check()).armed).toBe(false);
  });

  it("uses a supplied baseline instead of capturing on the first check", async () => {
    const onStop = vi.fn();
    const stop = new GlobalNetLossStop({ cohortEquityX18: sequence([x18(80)]), baselineX18: x18(100), stopX18: x18(25), onStop });
    const info = await stop.check(); // current 80 vs supplied baseline 100 -> drop 20
    expect(info.baselineX18).toBe(x18(100)); expect(info.dropX18).toBe(x18(20)); expect(info.tripped).toBe(false);
  });

  it("throttles equity reads to minIntervalMs (a sub-window check returns the last info)", async () => {
    const reader = vi.fn(sequence([x18(100), x18(50)]));
    let clock = 1000;
    const stop = new GlobalNetLossStop({ cohortEquityX18: reader, stopX18: x18(25), onStop: vi.fn(), minIntervalMs: 500, now: () => clock });
    await stop.check();              // reads (baseline 100)
    clock += 100; await stop.check(); // within 500ms window -> no read, returns last
    expect(reader).toHaveBeenCalledTimes(1);
    clock += 500; const trip = await stop.check(); // window elapsed -> reads 50, drop 50 >= 25
    expect(reader).toHaveBeenCalledTimes(2); expect(trip.tripped).toBe(true);
  });

  it("propagates a cohort-equity read failure (never a silent 'no loss')", async () => {
    const stop = new GlobalNetLossStop({ cohortEquityX18: async () => { throw new Error("read failed"); }, stopX18: x18(25), onStop: vi.fn() });
    await expect(stop.check()).rejects.toThrow("read failed");
  });
});

describe("cohortEquityReader", () => {
  it("sums each owner's USDT0 equity across the cohort", async () => {
    const equityFor: EquitySource = async (o) => (o === "a" ? x18(60).toString() : x18(40).toString());
    expect(await cohortEquityReader(["a", "b"], equityFor)()).toBe(x18(100));
  });
  it("throws when any wallet's equity is unobservable (null)", async () => {
    const equityFor: EquitySource = async (o) => (o === "a" ? x18(60).toString() : null);
    await expect(cohortEquityReader(["a", "b"], equityFor)()).rejects.toThrow("GLOBAL_STOP_EQUITY_UNKNOWN:b");
  });
});
