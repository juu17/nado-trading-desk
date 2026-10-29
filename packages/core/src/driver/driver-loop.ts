// =============================================================================
// @farm/core · driver/driver-loop — the engine's heartbeat. Periodically calls
// tick() on the injected TickDriver (Phase A's ExperimentCoordinator) to advance the
// A/B round FSM; fills arrive out-of-band via FillHintRouter → nudge, so the loop and
// the fill path are decoupled. The timer is injectable so tests drive it
// deterministically. Phase-0 scaffold: no coordinator is wired here.
// =============================================================================
import type { TickDriver } from "./types.js";

export interface DriverLoopOptions {
  /** Delay between the END of one tick and the START of the next (ms). */
  intervalMs: number;
  /** Injectable timer (tests pass a controllable one). Defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** A tick error is reported here and does NOT stop the loop (one bad tick must not
   *  kill the run); default swallows. */
  onError?: (error: unknown) => void;
}

export class DriverLoop {
  private running = false;
  private handle: unknown;
  constructor(
    private readonly driver: TickDriver,
    private readonly opts: DriverLoopOptions,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== undefined) {
      const clear = this.opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
      clear(this.handle);
      this.handle = undefined;
    }
  }

  /** Run one tick now (used by the loop and directly in tests); never throws. */
  async tickOnce(id?: string): Promise<void> {
    try {
      await this.driver.tick(id);
    } catch (error) {
      this.opts.onError?.(error);
    }
  }

  private schedule(): void {
    const setTimer = this.opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.handle = setTimer(() => {
      void this.loopStep();
    }, this.opts.intervalMs);
  }

  private async loopStep(): Promise<void> {
    if (!this.running) return;
    await this.tickOnce();
    if (this.running) this.schedule(); // re-arm only if still running (stop() mid-tick wins)
  }
}
