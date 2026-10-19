import { describe, it, expect } from "vitest";
import { Scheduler } from "./scheduler.js";
import type { JobExecutor } from "./scheduler.js";
import { InMemoryJobStore } from "./store.js";
import type { JobSpec } from "./store.js";
import type { Operation, WalletId } from "@farm/adapter-api";

const mkOp = (): Operation => ({
  kind: "chainCall", chainId: 57073,
  input: { chainId: 57073, to: { family: "evm", value: "0x0000000000000000000000000000000000000001" }, abi: [], method: "noop", args: [], clientId: "c" },
});
const job = (id: string, walletId: WalletId, extra: Partial<JobSpec> = {}): JobSpec => ({ id, walletId, op: mkOp(), ...extra });
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("Scheduler", () => {
  it("serializes jobs per wallet (one lane each)", async () => {
    const store = new InMemoryJobStore();
    const live = new Map<string, number>();
    let maxA = 0;
    const executor: JobExecutor = async (spec) => {
      const n = (live.get(spec.walletId) ?? 0) + 1; live.set(spec.walletId, n);
      if (spec.walletId === "A") maxA = Math.max(maxA, n);
      await new Promise((r) => setTimeout(r, 5));
      live.set(spec.walletId, (live.get(spec.walletId) ?? 1) - 1);
    };
    const s = new Scheduler({ store, executor, maxActiveWallets: 10 });
    await s.enqueue(job("a1", "A")); await s.enqueue(job("a2", "A")); await s.enqueue(job("b1", "B"));
    await s.onIdle();
    expect(maxA).toBe(1);                       // A never ran two at once
    expect((await s.stats()).done).toBe(3);
  });

  it("caps global concurrency across wallets", async () => {
    const store = new InMemoryJobStore();
    let live = 0, maxLive = 0;
    const executor: JobExecutor = async () => { live++; maxLive = Math.max(maxLive, live); await new Promise((r) => setTimeout(r, 5)); live--; };
    const s = new Scheduler({ store, executor, maxActiveWallets: 2 });
    for (const w of ["A", "B", "C", "D"]) await s.enqueue(job(`j-${w}`, w));
    await s.onIdle();
    expect(maxLive).toBe(2);
    expect((await s.stats()).done).toBe(4);
  });

  it("dedupes by job id (idempotency)", async () => {
    const store = new InMemoryJobStore();
    let runs = 0;
    const s = new Scheduler({ store, executor: async () => { runs++; } });
    expect(await s.enqueue(job("dup", "A"))).toBe(true);
    expect(await s.enqueue(job("dup", "A"))).toBe(false);
    await s.onIdle();
    expect(runs).toBe(1);
  });

  it("kill switch aborts in-flight jobs and re-queues them", async () => {
    const store = new InMemoryJobStore();
    let aborts = 0;
    const executor: JobExecutor = (_spec, signal) => new Promise((_res, rej) => {
      if (signal.aborted) return rej(new Error("aborted"));
      signal.addEventListener("abort", () => { aborts++; rej(new Error("aborted")); });
    });
    const s = new Scheduler({ store, executor });
    await s.enqueue(job("k", "A"));
    while (s.status().running === 0) await flush();
    s.halt();
    await flush(); await flush();
    expect(aborts).toBe(1);
    expect(s.status().running).toBe(0);
    expect((await store.get("k"))?.status).toBe("pending"); // re-queued, not failed
  });

  it("recover() re-queues interrupted 'running' jobs after a reload", async () => {
    const store = new InMemoryJobStore();
    await store.put({ id: "r1", walletId: "A", op: mkOp(), status: "running", attempts: 1, enqueuedAt: 0, updatedAt: 0 });
    let runs = 0;
    const s = new Scheduler({ store, executor: async () => { runs++; } });
    await s.recover();
    await s.onIdle();
    expect(runs).toBe(1);
    expect((await s.stats()).done).toBe(1);
  });

  it("calls onJobFailed when a job terminally fails (not on halt)", async () => {
    const store = new InMemoryJobStore();
    const failed: string[] = [];
    const executor: JobExecutor = async (spec) => { throw new Error(`boom ${spec.walletId}`); };
    const s = new Scheduler({ store, executor, onJobFailed: (spec, err) => failed.push(`${spec.walletId}:${err}`) });
    await s.enqueue(job("f", "A"));
    await s.onIdle();
    expect(failed).toEqual(["A:boom A"]);
    expect((await s.stats()).failed).toBe(1);
  });

  it("respects notBefore via the injected timer", async () => {
    const store = new InMemoryJobStore();
    let t = 0;
    const timers: Array<{ at: number; cb: () => void }> = [];
    const setTimer = (ms: number, cb: () => void): (() => void) => { const e = { at: t + ms, cb }; timers.push(e); return () => { const i = timers.indexOf(e); if (i >= 0) timers.splice(i, 1); }; };
    let runs = 0;
    const s = new Scheduler({ store, executor: async () => { runs++; }, now: () => t, setTimer });
    await s.enqueue(job("d", "A", { notBefore: 100 }));
    await flush();
    expect(runs).toBe(0);                 // t=0 < notBefore
    t = 100;
    for (const e of timers.splice(0)) if (e.at <= t) e.cb();
    await s.onIdle();
    expect(runs).toBe(1);
  });
});
