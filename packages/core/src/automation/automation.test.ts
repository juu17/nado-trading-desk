import { describe, it, expect, vi } from "vitest";
import { expandTemplate, resolveTargets, sampleBinding, runTemplateOnce, runTemplate } from "./automation.js";
import type { WalletTarget, OperationBuilder } from "./automation.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { InMemoryJobStore } from "../scheduler/store.js";
import type { ActionTemplate, Operation, NumberRange } from "@farm/adapter-api";

const WALLETS: WalletTarget[] = [
  { walletId: "w1", tags: ["cohortA", "maker"] },
  { walletId: "w2", tags: ["cohortA"] },
  { walletId: "w3", tags: ["cohortB"] },
];

const mkOp = (): Operation => ({
  kind: "chainCall", chainId: 57073,
  input: { chainId: 57073, to: { family: "evm", value: "0x0000000000000000000000000000000000000001" }, abi: [], method: "noop", args: [], clientId: "c" },
});
const build: OperationBuilder = () => mkOp();

function tpl(over: Partial<ActionTemplate> = {}): ActionTemplate {
  return {
    id: "t1", name: "test", version: 1, createdMs: 0, updatedMs: 0,
    steps: [{ id: "s1", op: "chainCall", params: {}, onFailure: "stop" }],
    schedule: { mode: "manual" },
    target: { kind: "all" },
    ...over,
  };
}

describe("automation", () => {
  it("resolveTargets: all / explicit / cohort / filter", () => {
    expect(resolveTargets({ kind: "all" }, WALLETS)).toHaveLength(3);
    expect(resolveTargets({ kind: "explicit", walletIds: ["w2"] }, WALLETS).map((w) => w.walletId)).toEqual(["w2"]);
    expect(resolveTargets({ kind: "cohort", cohortId: "cohortA" }, WALLETS).map((w) => w.walletId)).toEqual(["w1", "w2"]);
    expect(resolveTargets({ kind: "filter", tags: ["maker"] }, WALLETS).map((w) => w.walletId)).toEqual(["w1"]);
  });

  it("sampleBinding: NumberRange stays in bounds + snaps to step; literals pass through", () => {
    const r: NumberRange = { min: 10, max: 20, step: 5 };
    for (let i = 0; i < 50; i++) {
      const v = sampleBinding(r, Math.random) as number;
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThanOrEqual(20);
      expect((v - 10) % 5).toBe(0);
    }
    expect(sampleBinding("limit", Math.random)).toBe("limit");
    expect(sampleBinding(42, Math.random)).toBe(42);
  });

  it("expandTemplate: one job per (wallet, step), unique ids, cumulative notBefore", () => {
    const t = tpl({ steps: [
      { id: "s1", op: "chainCall", params: {}, onFailure: "stop", delayAfterMs: 100 },
      { id: "s2", op: "chainCall", params: {}, onFailure: "stop" },
    ] });
    const jobs = expandTemplate(t, WALLETS, build, { now: () => 1000 });
    expect(jobs).toHaveLength(6); // 3 wallets × 2 steps
    const w1 = jobs.filter((j) => j.walletId === "w1");
    expect(w1[0]!.notBefore).toBe(1000);  // first step: now
    expect(w1[1]!.notBefore).toBe(1100);  // second step: +100ms inter-step delay
    expect(new Set(jobs.map((j) => j.id)).size).toBe(6);
  });

  it("runTemplateOnce enqueues into the scheduler and is idempotent on re-run", async () => {
    const store = new InMemoryJobStore();
    const s = new Scheduler({ store, executor: async () => {} });
    const t = tpl();
    const first = await runTemplateOnce(s, t, WALLETS, build);
    expect(first.total).toBe(3);
    expect(first.enqueued).toBe(3);
    const second = await runTemplateOnce(s, t, WALLETS, build); // same ids → deduped
    expect(second.enqueued).toBe(0);
    await s.onIdle();
    expect((await s.stats()).done).toBe(3);
  });

  it("runTemplate cron: fires fresh jobs at each match, advancing the reschedule (recurrence works)", async () => {
    const store = new InMemoryJobStore();
    const s = new Scheduler({ store, executor: async () => {} });
    const timers: Array<{ ms: number; cb: () => void }> = [];
    let now = Date.UTC(2026, 0, 1, 0, 7, 30); // mutable clock, starts 00:07:30
    const handle = runTemplate(tpl({ schedule: { mode: "cron", expr: "*/15 * * * *" } }), {
      scheduler: s, wallets: WALLETS, build,
      expand: { now: () => now },
      setTimer: (ms, cb) => { timers.push({ ms, cb }); return () => {}; },
    });
    // cron does NOT fire immediately; it schedules the next */15 (00:15:00) -> 7m30s away.
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(7 * 60_000 + 30_000);
    // advance to the fire instant, fire occurrence #1
    now = Date.UTC(2026, 0, 1, 0, 15, 0);
    timers[0]!.cb();
    // the reschedule ADVANCES to the next quarter (00:30:00) -> 15m (not a re-fire of the same instant)
    expect(timers).toHaveLength(2);
    expect(timers[1]!.ms).toBe(15 * 60_000);
    // advance + fire occurrence #2
    now = Date.UTC(2026, 0, 1, 0, 30, 0);
    timers[1]!.cb();
    // TWO distinct occurrences enqueue FRESH jobs -> 6 done (not deduped to 3)
    await vi.waitFor(async () => { expect((await s.stats()).done).toBe(6); });
    handle.stop();
  });

  it("runTemplate interval: each tick enqueues FRESH jobs (recurrence works, not deduped)", async () => {
    const store = new InMemoryJobStore();
    const s = new Scheduler({ store, executor: async () => {} });
    const timers: Array<{ ms: number; cb: () => void }> = [];
    let now = 1_000_000; // mutable clock
    const handle = runTemplate(tpl({ schedule: { mode: "interval", everyMs: 60_000 } }), {
      scheduler: s, wallets: WALLETS, build,
      expand: { now: () => now },
      setTimer: (ms, cb) => { timers.push({ ms, cb }); return () => {}; },
    });
    // interval fires immediately (occurrence #1) then arms the next tick.
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(60_000);
    now = 1_060_000; // advance a tick, then fire occurrence #2
    timers[0]!.cb();
    // two distinct occurrences -> 6 fresh jobs (a frozen clock would have deduped to 3)
    await vi.waitFor(async () => { expect((await s.stats()).done).toBe(6); });
    handle.stop();
  });

  it("runTemplate: maxOccurrences caps a recurring schedule and calls onComplete", async () => {
    const store = new InMemoryJobStore();
    const s = new Scheduler({ store, executor: async () => {} });
    const timers: Array<{ ms: number; cb: () => void }> = [];
    let now = 1_000_000;
    let completed = false;
    const handle = runTemplate(tpl({ schedule: { mode: "interval", everyMs: 60_000 } }), {
      scheduler: s, wallets: WALLETS, build,
      expand: { now: () => now },
      setTimer: (ms, cb) => { timers.push({ ms, cb }); return () => {}; },
      maxOccurrences: 2,
      onComplete: () => { completed = true; },
    });
    // occurrence #1 fired immediately; a timer for #2 is armed.
    expect(timers).toHaveLength(1);
    now = 1_060_000;
    timers[0]!.cb(); // occurrence #2 fires, then the loop hits the cap -> onComplete, no new timer armed
    expect(completed).toBe(true);
    expect(timers).toHaveLength(1);
    await vi.waitFor(async () => { expect((await s.stats()).done).toBe(6); }); // exactly 2 occurrences x 3 wallets
    handle.stop();
  });

  it("runTemplate interval maxOccurrences=1: fires once and completes SYNCHRONOUSLY (no timer armed)", async () => {
    const store = new InMemoryJobStore();
    const s = new Scheduler({ store, executor: async () => {} });
    const timers: Array<{ ms: number; cb: () => void }> = [];
    let returned = false;
    let completedDuringStart = false;
    const handle = runTemplate(tpl({ schedule: { mode: "interval", everyMs: 60_000 } }), {
      scheduler: s, wallets: WALLETS, build,
      expand: { now: () => 1_000_000 },
      setTimer: (ms, cb) => { timers.push({ ms, cb }); return () => {}; },
      maxOccurrences: 1,
      onComplete: () => { completedDuringStart = !returned; }, // true iff it ran before runTemplate returned
    });
    returned = true;
    // The single immediate fire hits the cap in the same synchronous frame — onComplete must have run
    // during runTemplate (bulk.ts relies on this to not clobber the nulled handle), and no timer armed.
    expect(completedDuringStart).toBe(true);
    expect(timers).toHaveLength(0);
    await vi.waitFor(async () => { expect((await s.stats()).done).toBe(3); }); // exactly 1 occurrence x 3 wallets
    handle.stop();
  });

  it("runTemplate cron: a bad expr is surfaced via onError, not thrown into the caller", () => {
    const store = new InMemoryJobStore();
    const s = new Scheduler({ store, executor: async () => {} });
    const errs: Error[] = [];
    expect(() => runTemplate(tpl({ schedule: { mode: "cron", expr: "not a cron" } }), {
      scheduler: s, wallets: WALLETS, build,
      setTimer: () => () => {},
      onError: (_t, e) => errs.push(e),
    })).not.toThrow();
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toMatch(/cron/);
  });

  it("runTemplate: a rejecting enqueue is surfaced via onError, not left as an unhandled rejection", async () => {
    const failing = { enqueue: async () => { throw new Error("store down"); } } as unknown as Scheduler;
    const errs: Error[] = [];
    runTemplate(tpl(), { // default schedule is manual -> fires immediately
      scheduler: failing, wallets: WALLETS, build,
      setTimer: () => () => {},
      onError: (_t, e) => errs.push(e),
    });
    await vi.waitFor(() => { expect(errs).toHaveLength(1); });
    expect(errs[0]!.message).toMatch(/store down/);
  });
});
