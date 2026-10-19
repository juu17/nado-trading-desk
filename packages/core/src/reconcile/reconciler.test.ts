import { describe, it, expect } from "vitest";
import { reconcile, reconcileAndAlert } from "./reconciler.js";
import type { BalanceSnapshot } from "./reconciler.js";
import { Alerter, MemoryAlertSink } from "../alerting/alerting.js";

const snap = (walletId: string, asset: string, amount: number): BalanceSnapshot => ({ walletId, asset, amount });

describe("reconcile (M11)", () => {
  it("passes when expected matches actual", () => {
    const r = reconcile([snap("A", "USDT0", 100)], [snap("A", "USDT0", 100)]);
    expect(r.ok).toBe(true);
    expect(r.discrepancies).toHaveLength(0);
    expect(r.checkedKeys).toBe(1);
  });

  it("flags missing funds (actual < expected) as a warning, over threshold as critical", () => {
    const r = reconcile([snap("A", "USDT0", 100)], [snap("A", "USDT0", 60)], { theftThresholdAbs: 50 });
    expect(r.ok).toBe(false);
    expect(r.discrepancies[0]!.kind).toBe("missing-funds");
    expect(r.discrepancies[0]!.severity).toBe("warning"); // shortfall 40 < 50

    const r2 = reconcile([snap("A", "USDT0", 100)], [snap("A", "USDT0", 10)], { theftThresholdAbs: 50 });
    expect(r2.discrepancies[0]!.severity).toBe("critical"); // shortfall 90 >= 50
  });

  it("treats unexpected funds (actual > expected) as info and still ok", () => {
    const r = reconcile([snap("A", "USDT0", 100)], [snap("A", "USDT0", 130)]);
    expect(r.discrepancies[0]!.kind).toBe("unexpected-funds");
    expect(r.ok).toBe(true);
  });

  it("ignores drift within tolerance (abs + bps)", () => {
    expect(reconcile([snap("A", "USDT0", 100)], [snap("A", "USDT0", 99.5)], { toleranceAbs: 1 }).ok).toBe(true);
    expect(reconcile([snap("A", "USDT0", 1000)], [snap("A", "USDT0", 995)], { toleranceBps: 100 }).ok).toBe(true); // 0.5% < 1%
  });

  it("flags an asset present in expected but absent in actual as missing", () => {
    const r = reconcile([snap("A", "USDT0", 100)], [], { theftThresholdAbs: 1 });
    expect(r.discrepancies[0]!.kind).toBe("missing-funds");
    expect(r.discrepancies[0]!.severity).toBe("critical");
  });

  it("raises alerts for warning/critical discrepancies only", () => {
    const sink = new MemoryAlertSink();
    const alerter = new Alerter({ sinks: [sink] });
    reconcileAndAlert(
      [snap("A", "USDT0", 100), snap("B", "USDT0", 50)],
      [snap("A", "USDT0", 10), snap("B", "USDT0", 80)], // A missing 90 (crit), B extra 30 (info)
      alerter,
      { theftThresholdAbs: 50 },
    );
    expect(sink.alerts).toHaveLength(1); // only A's critical shortfall
    expect(sink.alerts[0]!.severity).toBe("critical");
    expect(sink.alerts[0]!.code).toContain("RECON_MISSING-FUNDS");
  });
});
