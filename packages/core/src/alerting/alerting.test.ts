import { describe, it, expect } from "vitest";
import { Alerter, MemoryAlertSink, ConsoleAlertSink } from "./alerting.js";

describe("alerting", () => {
  it("fans an alert to every sink with a timestamp", () => {
    const a = new MemoryAlertSink();
    const b = new MemoryAlertSink();
    const alerter = new Alerter({ sinks: [a, b], now: () => 123 });
    expect(alerter.raise({ severity: "critical", code: "FLEET_FAIL", title: "many failures" })).toBe(true);
    expect(a.alerts).toHaveLength(1);
    expect(b.alerts).toHaveLength(1);
    expect(a.alerts[0]!.severity).toBe("critical");
    expect(a.alerts[0]!.ts).toBe(123);
  });

  it("de-duplicates repeat codes within the window", () => {
    let t = 0;
    const sink = new MemoryAlertSink();
    const alerter = new Alerter({ sinks: [sink], dedupeWindowMs: 1000, now: () => t });
    expect(alerter.raise({ severity: "warning", code: "X", title: "x" })).toBe(true);
    expect(alerter.raise({ severity: "warning", code: "X", title: "x again" })).toBe(false); // deduped
    expect(alerter.raise({ severity: "warning", code: "Y", title: "y" })).toBe(true);         // different code
    t = 1001;
    expect(alerter.raise({ severity: "warning", code: "X", title: "x later" })).toBe(true);    // window elapsed
    expect(sink.alerts.map((a) => a.code)).toEqual(["X", "Y", "X"]);
  });

  it("ConsoleAlertSink formats a readable line", () => {
    const lines: string[] = [];
    new ConsoleAlertSink((m) => lines.push(m)).emit({ severity: "info", code: "C", title: "hello", detail: "d", ts: 0 });
    expect(lines[0]).toContain("[ALERT:info] C — hello · d");
  });
});
