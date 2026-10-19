// =============================================================================
// @farm/core · clock sync (M9) — the Nado order nonce encodes a recv-time, so a
// skewed operator clock gets orders rejected. ClockSync holds an offset estimated
// NTP-style from a trusted server time (the sequencer's `Date` header or an NTP
// probe), and exposes a corrected `now()`. Scaffold: the probe transport + where
// it's plugged into the nonce timestamp are wired by the composition root.
// =============================================================================
export interface SyncSample {
  /** Local time the request was sent. */
  requestSentAt?: number;
  /** Local time the response was received. */
  responseRecvAt?: number;
}

export class ClockSync {
  private offsetMs = 0;
  constructor(private readonly baseNow: () => number = Date.now) {}

  /**
   * Estimate the offset from a trusted server time. With both send + recv local
   * timestamps it corrects for round-trip latency (offset = serverTime − local
   * midpoint); otherwise it uses the current local time.
   */
  syncFrom(serverTimeMs: number, sample: SyncSample = {}): number {
    const sent = sample.requestSentAt ?? this.baseNow();
    const recv = sample.responseRecvAt ?? this.baseNow();
    const rtt = Math.max(0, recv - sent);
    const localMidpoint = sent + rtt / 2;
    this.offsetMs = serverTimeMs - localMidpoint;
    return this.offsetMs;
  }

  /** Current offset (serverTime − localTime), in ms. */
  get offset(): number { return this.offsetMs; }

  /** Corrected wall-clock time to use for nonces / timestamps. */
  now(): number { return this.baseNow() + this.offsetMs; }

  /** True when |offset| exceeds the threshold — raise a clock-drift alert. */
  isDrifting(thresholdMs: number): boolean { return Math.abs(this.offsetMs) > thresholdMs; }
}
