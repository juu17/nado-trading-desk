// =============================================================================
// @farm/core · alerting — out-of-band alerts for operator-impacting events
// (fleet failures, cap trips, drift). Scaffold: the Alerter fans de-duplicated
// alerts to pluggable sinks; the concrete channel (webhook/Slack/etc.) is wired
// by the composition root. Clock injectable for deterministic tests.
// =============================================================================
export type AlertSeverity = "info" | "warning" | "critical";

export interface Alert {
  severity: AlertSeverity;
  code: string; // dedupe key
  title: string;
  detail?: string;
  ts: number;
  context?: Record<string, unknown>;
}

export interface AlertSink { emit(alert: Alert): void | Promise<void> }

/** Dev sink — logs to a provided logger (defaults to console.error). */
export class ConsoleAlertSink implements AlertSink {
  constructor(private readonly log: (m: string) => void = (m) => console.error(m)) {}
  emit(a: Alert): void {
    this.log(`[ALERT:${a.severity}] ${a.code} — ${a.title}${a.detail ? " · " + a.detail : ""}`);
  }
}

/** Test/inspection sink — captures alerts in memory. */
export class MemoryAlertSink implements AlertSink {
  readonly alerts: Alert[] = [];
  emit(a: Alert): void { this.alerts.push(a); }
}

/** Out-of-band webhook sink (scaffold): the POST transport is injected. */
export class WebhookAlertSink implements AlertSink {
  constructor(private readonly post: (payload: unknown) => Promise<void>) {}
  async emit(a: Alert): Promise<void> {
    await this.post({ text: `[${a.severity}] ${a.code}: ${a.title}${a.detail ? " — " + a.detail : ""}`, alert: a });
  }
}

export interface AlerterOptions {
  sinks: AlertSink[];
  /** Suppress repeat alerts with the same `code` within this window (0 = never dedupe). */
  dedupeWindowMs?: number;
  now?: () => number;
}

export class Alerter {
  private readonly lastByCode = new Map<string, number>();
  constructor(private readonly opts: AlerterOptions) {}
  private now(): number { return (this.opts.now ?? Date.now)(); }

  /** Fan an alert to all sinks. Returns false if de-duplicated (not emitted). */
  raise(alert: Omit<Alert, "ts"> & { ts?: number }): boolean {
    const now = alert.ts ?? this.now();
    const win = this.opts.dedupeWindowMs ?? 0;
    if (win > 0) {
      const last = this.lastByCode.get(alert.code);
      if (last !== undefined && now - last < win) return false;
    }
    this.lastByCode.set(alert.code, now);
    const full: Alert = { ...alert, ts: now };
    for (const s of this.opts.sinks) void s.emit(full);
    return true;
  }
}
