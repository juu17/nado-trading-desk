// =============================================================================
// @farm/core · automation — fan an ActionTemplate across a cohort selection. It
// resolves targets (all / explicit / cohort-tag / tag-filter), samples per-wallet
// jitter from each NumberRange binding, builds one serializable Operation per
// (wallet, step), and enqueues the jobs into the scheduler. It sets NO strategy /
// math / guards — direction, size, frequency are the user's template values.
// RNG + clock + timer are injectable for deterministic tests.
// =============================================================================
import type {
  ActionTemplate, ActionStepTemplate, ParamBinding, ParamValue, NumberRange,
  TargetSelection, Operation, WalletId,
} from "@farm/adapter-api";
import type { JobSpec } from "../scheduler/store.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { nextCronTime } from "./cron.js";

export interface WalletTarget { walletId: WalletId; tags?: readonly string[] }

function isNumberRange(b: ParamBinding): b is NumberRange {
  return typeof b === "object" && b !== null && "min" in b && "max" in b;
}

/** Sample a binding: a NumberRange → a value in [min,max] (snapped to step); else the literal. */
export function sampleBinding(b: ParamBinding, rng: () => number): ParamValue {
  if (!isNumberRange(b)) return b;
  let v = b.min + rng() * (b.max - b.min);
  if (b.step && b.step > 0) v = b.min + Math.round((v - b.min) / b.step) * b.step;
  return v;
}

export function sampleParams(params: Readonly<Record<string, ParamBinding>>, rng: () => number): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [k, v] of Object.entries(params)) out[k] = sampleBinding(v, rng);
  return out;
}

/** Resolve a TargetSelection against the known wallets (cohort/tags ride wative Wallet tags). */
export function resolveTargets(sel: TargetSelection, all: readonly WalletTarget[]): WalletTarget[] {
  switch (sel.kind) {
    case "all": return [...all];
    case "explicit": { const ids = new Set(sel.walletIds ?? []); return all.filter((w) => ids.has(w.walletId)); }
    case "cohort": return sel.cohortId === undefined ? [] : all.filter((w) => (w.tags ?? []).includes(sel.cohortId as string));
    case "filter": { const tags = sel.tags ?? []; return tags.length === 0 ? [...all] : all.filter((w) => tags.some((t) => (w.tags ?? []).includes(t))); }
    default: return [];
  }
}

/** Maps a template step + sampled params into a concrete, serializable Operation.
 *  Protocol-specific (params → PlaceOrderInput etc.), so it is supplied by the caller. */
export type OperationBuilder = (step: ActionStepTemplate, wallet: WalletTarget, params: Record<string, ParamValue>) => Operation;

export interface ExpandOpts {
  rng?: () => number;
  now?: () => number;
  clientIdFor?: (walletId: WalletId, stepId: string, seq: number) => string;
}

/** Expand a template into one JobSpec per (target wallet, step), with per-wallet jitter
 *  and cumulative inter-step delay encoded as `notBefore`. */
export function expandTemplate(tpl: ActionTemplate, all: readonly WalletTarget[], build: OperationBuilder, opts: ExpandOpts = {}): JobSpec[] {
  const rng = opts.rng ?? Math.random;
  const now = (opts.now ?? Date.now)();
  const jobs: JobSpec[] = [];
  let seq = 0;
  for (const w of resolveTargets(tpl.target, all)) {
    let offset = 0;
    for (const step of tpl.steps) {
      const params = sampleParams(step.params, rng);
      const op = build(step, w, params);
      const id = opts.clientIdFor?.(w.walletId, step.id, seq) ?? `${tpl.id}:${w.walletId}:${step.id}:${seq}`;
      jobs.push({ id, walletId: w.walletId, op, templateId: tpl.id, notBefore: now + offset });
      const delay = step.delayAfterMs !== undefined ? Number(sampleBinding(step.delayAfterMs, rng)) : 0;
      offset += Math.max(0, delay);
      seq++;
    }
  }
  return jobs;
}

/** Expand once and enqueue into the scheduler (idempotent). Returns how many were new. */
export async function runTemplateOnce(
  scheduler: Scheduler, tpl: ActionTemplate, all: readonly WalletTarget[], build: OperationBuilder, opts?: ExpandOpts,
): Promise<{ enqueued: number; total: number }> {
  const jobs = expandTemplate(tpl, all, build, opts);
  let enqueued = 0;
  for (const j of jobs) if (await scheduler.enqueue(j)) enqueued++;
  return { enqueued, total: jobs.length };
}

const defaultSetTimer = (ms: number, cb: () => void): (() => void) => {
  const h = setTimeout(cb, ms);
  return () => clearTimeout(h);
};

export interface RunTemplateDeps {
  scheduler: Scheduler;
  wallets: readonly WalletTarget[];
  build: OperationBuilder;
  expand?: ExpandOpts;
  setTimer?: (ms: number, cb: () => void) => () => void;
  onError?: (tpl: ActionTemplate, err: Error) => void; // async-fire + bad-cron-expr failures (else swallowed)
  maxOccurrences?: number;              // hard bound on interval/cron fires (undefined = unbounded)
  onComplete?: (tpl: ActionTemplate) => void; // the schedule stopped itself (cap reached)
}

/** Drive a template per its ScheduleSpec. Returns a stop handle. */
export function runTemplate(tpl: ActionTemplate, deps: RunTemplateDeps): { stop: () => void } {
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const rng = deps.expand?.rng ?? Math.random;
  const now = deps.expand?.now ?? Date.now;
  let stopped = false;
  let occurrences = 0;
  let cancel: (() => void) | undefined;
  // A recurring schedule is bounded by maxOccurrences (if set): once that many fires have happened it
  // stops itself and calls onComplete, so a cron/interval can't place orders unbounded forever.
  const capReached = (): boolean => deps.maxOccurrences !== undefined && occurrences >= deps.maxOccurrences;
  // Each occurrence enqueues under a DISTINCT id namespace (the scheduled fire instant), so a
  // recurring schedule re-enqueues FRESH jobs every tick instead of colliding with the scheduler's
  // dedup (which would make every fire after the first a silent no-op). The async enqueue's failure
  // is surfaced via onError, never left as a floating (process-killing) unhandled rejection.
  const fire = (atMs: number): void => {
    occurrences++;
    const inner = deps.expand?.clientIdFor;
    const clientIdFor = inner
      ? (w: WalletId, s: string, seq: number): string => `${atMs}:${inner(w, s, seq)}`
      : (w: WalletId, s: string, seq: number): string => `${tpl.id}:${atMs}:${w}:${s}:${seq}`;
    void runTemplateOnce(deps.scheduler, tpl, deps.wallets, deps.build, { ...deps.expand, clientIdFor })
      .catch((err: unknown) => deps.onError?.(tpl, err instanceof Error ? err : new Error(String(err))));
  };

  switch (tpl.schedule.mode) {
    case "manual":
    case "once":
      fire(now());
      break;
    case "interval": {
      const base = tpl.schedule.everyMs;
      const jitter = tpl.schedule.jitterMs;
      const loop = (): void => {
        if (stopped) return;
        if (capReached()) { deps.onComplete?.(tpl); return; }
        const extra = jitter ? Math.max(0, Number(sampleBinding(jitter, rng))) : 0;
        cancel = setTimer(base + extra, () => { if (stopped) return; fire(now()); loop(); });
      };
      fire(now());
      loop();
      break;
    }
    case "cron": {
      // Fire at each matching UTC instant; recompute + reschedule after every fire. Unlike
      // `interval`, cron does NOT fire immediately — it waits for the next matching time. A bad or
      // impossible expr is surfaced via onError (not thrown into the caller) so one bad template
      // can't abort a loop that starts the others.
      const expr = tpl.schedule.expr; // capture while narrowed — the narrowing is lost inside the closure
      const schedule = (): void => {
        if (stopped) return;
        if (capReached()) { deps.onComplete?.(tpl); return; }
        const t = now();
        let next: number;
        try { next = nextCronTime(expr, t); }
        catch (err) { deps.onError?.(tpl, err instanceof Error ? err : new Error(String(err))); return; }
        cancel = setTimer(Math.max(0, next - t), () => { if (stopped) return; fire(next); schedule(); });
      };
      schedule();
      break;
    }
  }
  return { stop: () => { stopped = true; cancel?.(); } };
}
