// =============================================================================
// Console bulk engine (offline) — wires core/scheduler + core/automation to the
// real NadoAdapter via a mock executor. A launch expands an ActionTemplate across
// the targeted wallets (per-wallet jitter), enqueues one job per wallet into the
// Scheduler (per-wallet lanes, concurrency cap, kill switch), and each job runs
// the real adapter path (build EIP-712 → sign → mock gateway).
// =============================================================================
import { Scheduler, InMemoryJobStore, runTemplateOnce, runTemplate } from "@farm/core";
import type { JobExecutor, JobStore, WalletTarget, OperationBuilder, JobStatus } from "@farm/core";
import type { ActionTemplate, Operation, PlaceOrderInput, ParamBinding, Decimal, ChainId, ScheduleSpec } from "@farm/adapter-api";
import type { WalletVM, AccountingRecord } from "@farm/ui";
import { runOperation } from "./runtime";
import { isLiveWallet } from "./live";

const INK = 57073 as ChainId;

export interface BulkParams {
  market: string;
  side: "buy" | "sell";
  kind: "limit" | "market";
  size: ParamBinding;   // a number, or a NumberRange for per-wallet jitter
  price: ParamBinding;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });
}

class BulkEngine {
  private readonly store: JobStore = new InMemoryJobStore();
  private readonly scheduler: Scheduler;
  private walletsById = new Map<string, WalletVM>();
  private runCounter = 0;
  private activeSchedule: { stop: () => void } | null = null;
  faultRate = 0; // fault injection for demoing retry-failed-only
  scheduleError: string | null = null; // last bad-expr / failed-enqueue from a recurring schedule
  readonly activity: AccountingRecord[] = []; // accounting/export (Q61)

  constructor() {
    this.scheduler = new Scheduler({ store: this.store, executor: this.exec, maxActiveWallets: 50 });
  }

  register(wallets: readonly WalletVM[]): void {
    this.walletsById = new Map(wallets.map((w) => [w.id, w]));
  }

  private exec: JobExecutor = async (spec, signal) => {
    const wallet = this.walletsById.get(spec.walletId);
    if (!wallet) throw new Error(`unknown wallet ${spec.walletId}`);
    const live = isLiveWallet(wallet);
    if (!live) {
      await delay(40 + Math.floor(Math.random() * 160), signal); // simulate sequencer latency (mock only)
      if (this.faultRate > 0 && Math.random() < this.faultRate) throw new Error("simulated sequencer rejection");
    }
    if (signal.aborted) throw new Error("aborted"); // kill switch: don't issue after halt
    // live → server route (its own walletId + signer), forwarding the AbortSignal so the
    // kill switch aborts the in-flight submit, and the job id for sequencer idempotency;
    // mock → offline adapter. A live rejection throws → onJobFailed (never silently done).
    const result = await runOperation(wallet, spec.op, { signal, jobId: spec.id });
    this.recordActivity(wallet, spec.op);
    return result;
  };

  private recordActivity(wallet: WalletVM, op: Operation): void {
    if (op.kind !== "placeOrder") return;
    const i = op.input;
    const notional = Number(i.price ?? 0) * Number(i.size);
    this.activity.push({
      walletId: wallet.id, accountName: wallet.accountName, cohorts: wallet.cohorts,
      market: i.market, side: i.side, notional, fee: notional * 0.0003, status: "open", ts: Date.now(),
    });
    if (this.activity.length > 5000) this.activity.splice(0, this.activity.length - 5000);
  }

  /** Re-enqueue only the jobs that failed (status 'failed' re-enqueues; 'done' never does). */
  async retryFailed(): Promise<number> {
    this.scheduleError = null; // retry is not a schedule run; clear any stale schedule error
    const failed = await this.store.list("failed");
    for (const r of failed) {
      await this.scheduler.enqueue({ id: r.id, walletId: r.walletId, op: r.op, templateId: r.templateId, priority: r.priority });
    }
    return failed.length;
  }

  private template(runId: number, params: BulkParams, schedule: ScheduleSpec): ActionTemplate {
    return {
      id: `bulk-${runId}`, name: "Bulk place order", version: 1, createdMs: Date.now(), updatedMs: Date.now(),
      steps: [{
        id: "place", op: "placeOrder", protocolId: "nado",
        params: { market: params.market, side: params.side, kind: params.kind, size: params.size, price: params.price },
        onFailure: "continue",
      }],
      schedule,
      target: { kind: "all" }, // the caller passes the already-scoped wallet pool
    };
  }

  private buildOp(runId: number): OperationBuilder {
    return (_step, wallet, p) => {
      const kind = String(p.kind ?? "limit") as "limit" | "market";
      const input: PlaceOrderInput = {
        market: String(p.market),
        side: String(p.side) as "buy" | "sell",
        kind,
        size: String(p.size) as Decimal,
        price: kind === "market" ? undefined : (String(p.price) as Decimal),
        postOnly: kind !== "market",
        clientId: `${runId}:${wallet.walletId}`,
      };
      const op: Operation = { kind: "placeOrder", protocolId: "nado", chainId: INK, input };
      return op;
    };
  }

  /** One-shot bulk fire (mode manual). */
  async launch(params: BulkParams, targets: readonly WalletTarget[]): Promise<{ enqueued: number; total: number }> {
    this.scheduleError = null; // one-shot run: clear any stale schedule error
    if (this.scheduler.status().running === 0) await this.store.clear(); // fresh run
    this.scheduler.resume(); // clear any prior kill-switch halt so this run dispatches
    const runId = ++this.runCounter;
    return runTemplateOnce(this.scheduler, this.template(runId, params, { mode: "manual" }), [...targets], this.buildOp(runId));
  }

  /** Start a RECURRING bulk run on a schedule (interval/cron). The scheduler fires the cohort at each
   *  occurrence (per-occurrence job ids, so every tick enqueues fresh jobs), bounded by maxOccurrences
   *  (undefined = unbounded); call stopSchedule() to end it early. A bad cron expr or a failed enqueue
   *  surfaces via scheduleError instead of throwing; onComplete fires when the cap is reached. */
  async launchScheduled(params: BulkParams, targets: readonly WalletTarget[], schedule: ScheduleSpec, maxOccurrences?: number): Promise<void> {
    this.stopSchedule();
    if (this.scheduler.status().running === 0) await this.store.clear(); // fresh schedule: drop killed/stale jobs
    this.scheduler.resume(); // clear any prior kill-switch halt so new fires actually dispatch
    this.scheduleError = null;
    let completedSync = false;
    const runId = ++this.runCounter;
    const handle = runTemplate(this.template(runId, params, schedule), {
      scheduler: this.scheduler, wallets: [...targets], build: this.buildOp(runId),
      maxOccurrences,
      onError: (_t, e) => { this.scheduleError = e.message; },
      onComplete: () => { this.activeSchedule = null; completedSync = true; }, // cap reached -> ends, UI settles
    });
    // Only hold the handle if the schedule is still live. A fatal start (bad/impossible cron threw
    // synchronously) or a SYNCHRONOUS completion (interval maxOccurrences=1 completes during
    // runTemplate) already ended it — don't clobber that back to a dead handle.
    this.activeSchedule = (this.scheduleError || completedSync) ? null : handle;
  }

  stopSchedule(): void { this.activeSchedule?.stop(); this.activeSchedule = null; }
  get scheduleActive(): boolean { return this.activeSchedule !== null; }

  /** Kill switch: stop the recurring schedule (no more fires) AND halt in-flight jobs. */
  halt(): void { this.stopSchedule(); this.scheduler.halt(); }
  resume(): void { this.scheduler.resume(); }
  get halted(): boolean { return this.scheduler.status().halted; }
  get running(): number { return this.scheduler.status().running; }
  stats(): Promise<Record<JobStatus, number>> { return this.scheduler.stats(); }
}

export const bulk = new BulkEngine();
