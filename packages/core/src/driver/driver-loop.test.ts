import { describe, it, expect } from "vitest";
import { DriverLoop } from "./driver-loop.js";
import type { TickDriver } from "./types.js";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// A controllable timer: captures the pending callback so the test fires ticks
// deterministically instead of waiting on wall-clock intervals.
function fakeTimer() {
  let pending: (() => void) | null = null;
  return {
    setTimer: (fn: () => void) => { pending = fn; return 1 as unknown; },
    clearTimer: () => { pending = null; },
    get armed() { return pending !== null; },
    async fire() { const fn = pending; pending = null; fn?.(); await flush(); },
  };
}

describe("DriverLoop", () => {
  it("ticks once per armed interval and stops cleanly", async () => {
    let ticks = 0;
    const driver: TickDriver = { tick: async () => { ticks++; } };
    const t = fakeTimer();
    const loop = new DriverLoop(driver, { intervalMs: 10, setTimer: t.setTimer, clearTimer: t.clearTimer });

    loop.start();
    expect(loop.isRunning).toBe(true);
    expect(t.armed).toBe(true); // first interval armed, not yet fired

    await t.fire(); // → tick #1, re-armed
    expect(ticks).toBe(1);
    expect(t.armed).toBe(true);

    await t.fire(); // → tick #2, re-armed
    expect(ticks).toBe(2);

    loop.stop();
    expect(loop.isRunning).toBe(false);
    expect(t.armed).toBe(false); // the pending timer was cleared
  });

  it("does not re-arm when stopped during a tick", async () => {
    let ticks = 0;
    const t = fakeTimer();
    const loop = new DriverLoop(
      { tick: async () => { ticks++; loop.stop(); } },
      { intervalMs: 10, setTimer: t.setTimer, clearTimer: t.clearTimer },
    );
    loop.start();
    await t.fire(); // tick runs, calls stop() → must NOT re-arm
    expect(ticks).toBe(1);
    expect(t.armed).toBe(false);
  });

  it("a throwing tick is reported and the loop keeps running", async () => {
    const errors: unknown[] = [];
    let ticks = 0;
    const t = fakeTimer();
    const loop = new DriverLoop(
      { tick: async () => { ticks++; throw new Error("tick boom"); } },
      { intervalMs: 10, setTimer: t.setTimer, clearTimer: t.clearTimer, onError: (e) => errors.push(e) },
    );
    loop.start();
    await t.fire();
    expect(ticks).toBe(1);
    expect(errors).toHaveLength(1);
    expect(t.armed).toBe(true); // survived the error, re-armed
    await t.fire();
    expect(ticks).toBe(2);
  });

  it("start() is idempotent (no double-arm)", () => {
    const t = fakeTimer();
    let arms = 0;
    const loop = new DriverLoop(
      { tick: async () => {} },
      { intervalMs: 10, setTimer: (fn) => { arms++; return t.setTimer(fn); }, clearTimer: t.clearTimer },
    );
    loop.start();
    loop.start();
    expect(arms).toBe(1);
    loop.stop();
  });
});
