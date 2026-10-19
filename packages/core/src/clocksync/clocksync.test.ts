import { describe, it, expect } from "vitest";
import { ClockSync } from "./clocksync.js";

describe("ClockSync (M9)", () => {
  it("estimates the offset NTP-style (corrects for round-trip)", () => {
    let local = 1100;
    const cs = new ClockSync(() => local);
    // request sent at 1000, response at 1100 → rtt 100, midpoint 1050; server says 2050
    const offset = cs.syncFrom(2050, { requestSentAt: 1000, responseRecvAt: 1100 });
    expect(offset).toBe(1000);
    expect(cs.offset).toBe(1000);
    expect(cs.now()).toBe(2100); // baseNow 1100 + offset 1000
    local = 1200;
    expect(cs.now()).toBe(2200);
  });

  it("uses local time when no round-trip samples are given", () => {
    const cs = new ClockSync(() => 5000);
    expect(cs.syncFrom(5000)).toBe(0); // in sync
    expect(cs.now()).toBe(5000);
  });

  it("flags drift past the threshold", () => {
    const cs = new ClockSync(() => 0);
    cs.syncFrom(900, { requestSentAt: 0, responseRecvAt: 0 }); // offset 900
    expect(cs.isDrifting(500)).toBe(true);
    expect(cs.isDrifting(1000)).toBe(false);
  });
});
