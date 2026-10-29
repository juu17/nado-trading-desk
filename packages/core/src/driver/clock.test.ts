import { describe, it, expect } from "vitest";
import { ClockSync } from "../clocksync/index.js";
import { clockSourceFromSync, systemClock } from "./clock.js";

describe("clockSourceFromSync", () => {
  it("reflects the ClockSync offset (the corrected now feeds order nonces)", () => {
    let local = 1_000_000;
    const sync = new ClockSync(() => local);
    // server is 5s ahead; with equal send/recv the offset is +5000.
    sync.syncFrom(local + 5000, { requestSentAt: local, responseRecvAt: local });
    const clock = clockSourceFromSync(sync);
    expect(clock()).toBe(local + 5000);
    // and it tracks the live local clock, not a frozen snapshot
    local = 2_000_000;
    expect(clock()).toBe(local + 5000);
    // unbound-safe: the function can be passed as the coordinator's `now`
    const now: () => number = clock;
    expect(now()).toBe(local + 5000);
  });

  it("systemClock returns wall-clock time", () => {
    const before = Date.now();
    const t = systemClock();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });
});
