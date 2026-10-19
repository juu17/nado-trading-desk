// =============================================================================
// @farm/core · fleet scheduler — runs persisted jobs with:
//  • per-wallet serial lanes (one in-flight job per wallet; nonces never race),
//  • a global concurrency cap (the rotating active cohort, D2),
//  • a KILL SWITCH (halt aborts in-flight via AbortSignal + stops dispatch),
//  • resume-after-reload (recover() re-queues interrupted 'running' jobs),
//  • idempotency (dedupe by job id; a 'done' job never re-runs).
// Clock + timer are injectable so delayed dispatch is unit-tested without real time.
// =============================================================================
import type { WalletId } from "@farm/adapter-api";
import type { JobSpec, JobRecord, JobStore, JobStatus } from "./store.js";

export type JobExecutor = (spec: JobSpec, signal: AbortSignal) => Promise<unknown>;

export interface SchedulerDeps {
  store: JobStore;
  executor: JobExecutor;
  maxActiveWallets?: number;                 // global concurrency cap (default 100)
  now?: () => number;
  setTimer?: (ms: number, cb: () => void) => () => void; // returns a cancel fn
  /** Called when a job terminally fails (not when interrupted by halt). Wire to an Alerter. */
  onJobFailed?: (spec: JobSpec, error: string) => void;
}

const defaultSetTimer = (ms: number, cb: () => void): (() => void) => {
  const h = setTimeout(cb, ms);
  return () => clearTimeout(h);
};

export class Scheduler {
  private readonly store: JobStore;
  private readonly executor: JobExecutor;
  private readonly cap: number;
  private readonly running = new Map<string, { walletId: WalletId; controller: AbortController }>();
  private halted = false;
  private pumping = false;
  private dirty = false;
  private cancelWake?: () => void;
  private wakeAt?: number;
  private idleWaiters: Array<() => void> = [];

  constructor(deps: SchedulerDeps) {
    this.store = deps.store;
    this.executor = deps.executor;
    this.cap = deps.maxActiveWallets ?? 100;
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? defaultSetTimer;
    this.onJobFailed = deps.onJobFailed;
  }
  private readonly now: () => number;
  private readonly setTimer: (ms: number, cb: () => void) => () => void;
  private readonly onJobFailed?: (spec: JobSpec, error: string) => void;

  /** Enqueue a job. Returns false if an existing pending/running/done job dedupes it. */
  async enqueue(spec: JobSpec): Promise<boolean> {
    const existing = await this.store.get(spec.id);
    if (existing && existing.status !== "failed") return false; // idempotent
    const now = this.now();
    const rec: JobRecord = { ...spec, status: "pending", attempts: existing?.attempts ?? 0, enqueuedAt: existing?.enqueuedAt ?? now, updatedAt: now };
    await this.store.put(rec);
    void this.pump();
    return true;
  }

  /** KILL SWITCH — abort every in-flight job and stop dispatching. */
  halt(): void {
    this.halted = true;
    this.cancelWake?.();
    this.cancelWake = undefined; this.wakeAt = undefined;
    for (const { controller } of this.running.values()) controller.abort();
  }
  resume(): void { if (this.halted) { this.halted = false; void this.pump(); } }
  get isHalted(): boolean { return this.halted; }

  /** Resume after a reload: re-queue jobs left 'running' by an interrupted session. */
  async recover(): Promise<void> {
    for (const r of await this.store.list("running")) {
      await this.store.put({ ...r, status: "pending", updatedAt: this.now() });
    }
    void this.pump();
  }

  status(): { running: number; halted: boolean } { return { running: this.running.size, halted: this.halted }; }
  async stats(): Promise<Record<JobStatus, number>> {
    const all = await this.store.list();
    const out: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
    for (const r of all) out[r.status]++;
    return out;
  }

  /** Resolves when nothing is running and no job is ready to run. */
  onIdle(): Promise<void> {
    return new Promise<void>((resolve) => { this.idleWaiters.push(resolve); void this.checkIdle(); });
  }

  private busyWallets(): Set<WalletId> {
    return new Set([...this.running.values()].map((r) => r.walletId));
  }

  private async pickNext(): Promise<JobRecord | undefined> {
    const pending = await this.store.list("pending");
    const now = this.now();
    const busy = this.busyWallets();
    const eligible = pending.filter((j) => !this.running.has(j.id) && !busy.has(j.walletId) && (j.notBefore ?? 0) <= now);
    if (eligible.length === 0) { this.scheduleWakeForDelayed(pending, busy, now); return undefined; }
    eligible.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.enqueuedAt - b.enqueuedAt);
    return eligible[0];
  }

  private scheduleWakeForDelayed(pending: readonly JobRecord[], busy: Set<WalletId>, now: number): void {
    let soonest = Infinity;
    for (const j of pending) {
      if (this.running.has(j.id) || busy.has(j.walletId)) continue;
      const nb = j.notBefore ?? 0;
      if (nb > now && nb < soonest) soonest = nb;
    }
    if (!Number.isFinite(soonest)) return;
    if (this.wakeAt !== undefined && this.wakeAt <= soonest) return; // a sooner wake is already armed
    this.cancelWake?.();
    this.wakeAt = soonest;
    this.cancelWake = this.setTimer(Math.max(1, soonest - now), () => { this.cancelWake = undefined; this.wakeAt = undefined; void this.pump(); });
  }

  private startJob(rec: JobRecord): void {
    const controller = new AbortController();
    this.running.set(rec.id, { walletId: rec.walletId, controller });
    void this.store.put({ ...rec, status: "running", attempts: rec.attempts + 1, updatedAt: this.now() });
    this.executor({ id: rec.id, walletId: rec.walletId, op: rec.op, templateId: rec.templateId, priority: rec.priority, notBefore: rec.notBefore }, controller.signal)
      .then(async (result) => { await this.store.put({ ...rec, status: "done", attempts: rec.attempts + 1, updatedAt: this.now(), result }); })
      .catch(async (err) => {
        const interrupted = controller.signal.aborted || this.halted;
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.store.put({ ...rec, status: interrupted ? "pending" : "failed", attempts: rec.attempts + 1, updatedAt: this.now(), error: errMsg });
        if (!interrupted) this.onJobFailed?.({ id: rec.id, walletId: rec.walletId, op: rec.op, templateId: rec.templateId, priority: rec.priority, notBefore: rec.notBefore }, errMsg);
      })
      .finally(() => { this.running.delete(rec.id); void this.pump(); });
  }

  private async pump(): Promise<void> {
    if (this.halted) { this.checkIdle(); return; }
    if (this.pumping) { this.dirty = true; return; }
    this.pumping = true;
    try {
      do {
        this.dirty = false;
        while (!this.halted && this.running.size < this.cap) {
          const next = await this.pickNext();
          if (!next) break;
          this.startJob(next);
        }
      } while (this.dirty && !this.halted);
    } finally { this.pumping = false; }
    await this.checkIdle();
  }

  private async checkIdle(): Promise<void> {
    if (this.running.size > 0 || this.idleWaiters.length === 0) return;
    const pending = await this.store.list("pending");
    const now = this.now();
    const ready = pending.some((j) => (j.notBefore ?? 0) <= now);
    if (ready && !this.halted) return; // still work to do
    const waiters = this.idleWaiters; this.idleWaiters = [];
    for (const w of waiters) w();
  }
}
