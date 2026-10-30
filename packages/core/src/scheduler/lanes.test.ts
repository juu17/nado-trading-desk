// Guards the adopted runLanes (A-1). The capacity invariants are re-derived here
// independently of the intern's suite: (1) at most `lanes` run concurrently, (2) on
// the first failure no new item is started, (3) the call settles only after every
// in-flight item has ended (nothing outlives the caller), (4) the first error is thrown.
import { describe, it, expect } from "vitest";
import { runLanes } from "./lanes.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

describe("scheduler/runLanes", () => {
  it("caps concurrency at `lanes` and processes every item when all succeed", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let inflight = 0;
    let peak = 0;
    const done: number[] = [];
    await runLanes(items, 4, async (i) => {
      inflight++;
      peak = Math.max(peak, inflight);
      await tick();
      done.push(i);
      inflight--;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually parallel
    expect(done.sort((a, b) => a - b)).toEqual(items);
  });

  it("uses at most min(lanes, items) workers (never spins idle lanes)", async () => {
    let peak = 0;
    let inflight = 0;
    await runLanes([1, 2], 8, async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await tick();
      inflight--;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("stops taking new items after the first failure and rethrows it", async () => {
    const started: number[] = [];
    let settled = 0;
    const err = new Error("boom-7");
    await expect(
      runLanes(Array.from({ length: 50 }, (_, i) => i), 2, async (i) => {
        started.push(i);
        await tick();
        settled++;
        if (i === 7) throw err;
      }),
    ).rejects.toBe(err);
    // No worker should have drained the whole queue past the failure.
    expect(started.length).toBeLessThan(50);
    // Every started item must have finished before settle (no orphans).
    expect(settled).toBe(started.length);
  });

  it("surfaces the FIRST failure even when a later item also throws", async () => {
    const first = new Error("first");
    const second = new Error("second");
    await expect(
      runLanes([first, second], 1, async (e) => {
        await tick();
        throw e;
      }),
    ).rejects.toBe(first);
  });

  it("is a no-op on an empty item list", async () => {
    let calls = 0;
    await runLanes([], 4, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });
});
