import { slotStart, slotTiming } from "./timing.js";
import { pairProductId } from "./markets.js";
import { runLanes } from "../scheduler/lanes.js";
import { isPairRolling, livePairs, outgoingStep, pairById, pairFunded, pairPlace, pairStepId, returnsStepId, targetPair } from "./pairRolling.js";
import { owner, rawAmount, refuse, type OperationsStore, type DeskOperations, type ProtectedOrder } from "../funding/types.js";
import { assertWalletPlanPair, activeWalletUsePlan } from "../funding/wallet-use-plan.js";
import { assertExperimentWalletsAvailable } from "./guards.js";
import { makeExperimentCampaign, validateExperiments } from "./validation.js";
import { assertExperimentRouteApproval } from "./route.js";
import { pairRoundTurnover } from "./sizing.js";
import { addRoundCost, costGateDecision, roundCost, roundCostFacts } from "./cost.js";
import { FUNDING_ROUTE_TARGET, ExperimentUnsentOrderError } from "./types.js";
import { EXPERIMENT_RETRY_MS, EXPERIMENT_SET_ASIDE_AFTER, PAIR_CLOSE_ONLY_MS, PAIR_LONELY_MS, experimentAutoRetry, experimentErrorCode, experimentNeedsReview, experimentRetryDelay, isTransientExperimentError } from "./recovery.js";
import type { ExperimentCampaign, ExperimentCampaignInput, ExperimentConnector, ExperimentCoordinatorOptions, ExperimentOrder, ExperimentOrderFact, ExperimentOrderRequest, ExperimentOrderRole, ExperimentPair, ExperimentPairSnapshot, ExperimentRound, ExperimentRolloverFact } from "./types.js";
import type { ExperimentEvent } from "./types.js";
import type { ExperimentCompactionBody, ExperimentCompactionChunk, ExperimentCompactionOptions, ExperimentArchiveReceipt, ExperimentArchivedWalletTotals } from "./types.js";

type Token = { epoch: number; generation: number };
const opposite = (side: "BUY" | "SELL") => side === "BUY" ? "SELL" : "BUY";
/** IOC follow attempts for the source's actual fill before the round is closed early. */
export const FOLLOW_ATTEMPTS = 6;
/** B must have followed by the end of the round's slot (5 or 3 minutes, see timing.ts); a
 *  later follow (e.g. after a long pause) would no longer mirror A, so A's position is
 *  closed instead. */
const followDeadline = (r: ExperimentRound) => slotStart(r.openAt, r.slotMs) + slotTiming(r.slotMs).slotMs;
/** Below one USDT0 of flat capital a pair cannot place any order on a sized plan. */
const CAPITAL_FLOOR_X18 = 10n ** 18n;
/** A's maker open may be re-posted at the current best price until this far into its
 *  5-minute slot (3-minute slots: see timing.ts); any fill ends the re-posting and B follows. */
export const OPEN_WINDOW_MS = 240_000;
/** With best-price tracking, a resting maker is re-posted when it stops being best and in
 *  any case before its 60 s signed expiry. */
const MAKER_MAX_AGE_MS = 50_000;
/** A group transfer whose last attempt ended unknown (in 1.3.3 a read that did not answer)
 *  is looked at again after this long instead of a minute: the retry only queries the
 *  original requests first, never re-sends one of unknown outcome, so a short wait is safe. */
export const ROLLOVER_RETRY_MS = 15_000;
/** Pair rolling: a pair downstream of one set aside never gets money; it ends with this code. */
export const SOURCE_SET_ASIDE = "EXPERIMENT_SOURCE_SET_ASIDE";
/** Pair rolling: a step waiting for its credit is looked at again after this (a hand-over
 *  takes about 2.5 minutes; reads stay low with many steps in flight); a failed or unknown
 *  one after ROLLOVER_RETRY_MS. */
const PAIR_STEP_RECHECK_MS = 10_000;
/** A return to F whose payout could not be matched: the operator's to look at (never sent again). */
const RECEIPT_REVIEW = ["RECEIPT_NOT_CONFIRMED", "LEGACY_RECEIPT_REVIEW_REQUIRED"];
/** Lookups that need no sending pass after them: every row is sent, or the step waits for F. */
const NO_SEND_PASS = ["RECEIPT_PENDING_QUERY_ONLY", "FUNDING_ACCOUNT_RECEIPT_PENDING", ...RECEIPT_REVIEW];
const openWindowEnd = (r: ExperimentRound) => slotStart(r.openAt, r.slotMs) + slotTiming(r.slotMs).openWindowMs;
/* After the hold, B's maker close may rest (re-quoted at the best price) slotTiming().closeMakerMs
 * before both sides finish by taker orders; low-cost opening releases waiting rounds early in
 * a slot (gatedOpenByMs / gatedReleaseMs). */
/** A step that leads straight to the next one (A's fill seen → cancel the rest → B follows;
 *  B's maker close filled → A closes → B's remainder) continues in the same pass instead of
 *  waiting for the next timer pass: at most this many steps, and at most PASS_ORDERS new
 *  orders per pass (repeated taker attempts are then spread over passes). */
const CHAIN_STEPS = 12, PASS_ORDERS = 3;
/** A pass also stops after this long, so one pair's long chain (each lookup may wait for the
 *  exchange's history) does not hold back the next timer pass of every other pair. */
const PASS_MS = 6_000;
/** Pairs read at once when a group ends (flat proofs) and when unresolved orders are looked up on recovery. */
const FINISH_LANES = 4;
/** Without loss or fee limits, a pair that is only waiting (for its opening time, or the end
 *  of its hold) re-reads its accounts at most this often (for the statistics shown). */
const IDLE_READ_MS = 10_000;
/** Account statistics (equity, result) are written at most this often per pair; a first
 *  baseline or a limit being reached is written at once. Limits are checked on every read. */
const STATS_WRITE_MS = 10_000;
/** Within a pass, an account read is reused for a wallet only while this young and only if
 *  none of that wallet's orders changed since. */
const VIEW_MAX_AGE_MS = 5_000;
/** An order the exchange took whose fill its history does not show yet (the history lags
 *  the exchange by about a second) is looked up again before the pair pauses: for at least
 *  this long and this many answers (a pass after a long gap, e.g. the computer slept, is
 *  not taken as the history having lagged that long). */
const FACT_LAG_MS = 20_000, FACT_LAG_TRIES = 5;
/** With live positions, a resting maker whose wallet shows no new fill is still looked up
 *  at least this often. */
const MAKER_LOOKUP_MS = 15_000;
/** While fills are pushed (see ExperimentConnector.fillHints), a resting maker's wallet is
 *  read at most this often: a fill wakes the pair at once, so the read is only a fallback. */
const RESTING_READ_MS = 5_000;
/** States in which the pair is one-sided or closing: its reads may go first. */
const HOT_STATES: readonly ExperimentRound["state"][] = ["CANCEL_A_OPEN", "B_OPEN", "A_CLOSE", "CANCEL_A_CLOSE", "B_CLOSE", "CANCEL_B_CLOSE_MAKER"];
/** An account read and, per wallet, that wallet's orders in the round when it was taken. */
type View = { snap: ExperimentPairSnapshot; at: number; round?: string; marks: { a: string; b: string }; recorded: boolean };
const mark = (r: ExperimentRound | undefined, a: string) => JSON.stringify(r?.orders.filter(o => o.owner === a).map(o => [o.id, o.state, o.filledX18, o.cancelState ?? ""]) ?? []);
/** No new risk: an exit (ends the task) or a pause-and-flatten (resumable). */
/** Close-only: the task is exiting or flattening, or (1.4.0) this pair is being wound down
 *  after it kept failing (closeOnlyAt): it closes what it holds and opens nothing new. */
const winding = (c: ExperimentCampaign, p?: Pick<ExperimentPair, "closeOnlyAt">) => Boolean(c.exitRequested || c.flattenRequested || p?.closeOnlyAt !== undefined);
const last = (p: ExperimentPair) => p.rounds[p.rounds.length - 1];
/** History alone is not a running slot. An unfinished round or unresolved request
 * retains its slot even while set aside, so its recovery/close is never rate-limited. */
const unfinishedPair = (p: ExperimentPair) => p.rounds.some(r => r.state !== "COMPLETED" || r.orders.some(o =>
  o.state !== "ABORTED_UNSENT" && (o.state !== "TERMINAL" || (o.cancelState !== undefined && o.cancelState !== "CONFIRMED"))));
const occupiesPairSlot = (p: ExperimentPair) => p.state === "ACTIVE" || unfinishedPair(p);
const orderFor = (r: ExperimentRound, role: ExperimentOrderRole) => [...r.orders].reverse().find(o => o.role === role && o.state !== "ABORTED_UNSENT");
const signed = (v: unknown): bigint => {
  if (typeof v !== "string" || v.length > 79 || !/^-?(?:0|[1-9][0-9]*)$/.test(v)) refuse("EXPERIMENT_INVALID_POSITION");
  return BigInt(v);
};
const abs = (n: bigint) => n < 0n ? -n : n;

/** A wallet's result since its baseline. The hub's (1.5) leaves out returns credited to it
 *  after the baseline: they are money moved in, not trading (audit of 1.5, pair rolling). */
function hubAdjustedPnl(c: ExperimentCampaign, wallet: string, equity: bigint, stat: { baselineEquityX18?: string; baselineHubInflowRaw?: string }, inflow?: bigint): bigint {
  const base = equity - BigInt(stat.baselineEquityX18!);
  if (inflow === undefined || wallet !== c.route?.fundingAccount || stat.baselineHubInflowRaw === undefined) return base;
  return base - (inflow - BigInt(stat.baselineHubInflowRaw)) * 1_000_000_000_000n;
}
export class ExperimentCoordinator {
  private halted = true;
  private generation = 0;
  private busy = false;
  /** Read-only recovery in progress: no wake-up may step a pair meanwhile. */
  private reconciling = false;
  /** Pairs being stepped right now (by the timer pass or a wake-up): one runner per pair. */
  private readonly lanes = new Set<string>();
  /** A wake-up arrived while the pair was being stepped: it is stepped once more at once. */
  private readonly woken = new Set<string>();
  /** Pair rolling: when each transfer step may be looked at again (in memory only). */
  private readonly stepAt = new Map<string, number>();
  /** Per pair: when its accounts were last read, and its statistics last written. */
  private readonly readAt = new Map<string, number>();
  private readonly statsAt = new Map<string, number>();
  /** Per order: the first "not in the history yet" answer (and how many), and the last lookup. */
  private readonly lagSince = new Map<string, { since: number; count: number }>();
  private readonly lookedAt = new Map<string, number>();
  /** Receipt-time grace for a known non-final close; old/recovered creation times
   * must not immediately spend the new session's opportunity to reconcile it. */
  private readonly closeLagSince = new Map<string,{ since:number; filled:bigint }>();
  /** Markets (chain:product) whose exchange refused B's post-only reduce-only close as a
   *  maker (2067): later rounds close by taker at once instead of sending a maker close the
   *  exchange refuses every round. Kept until restart, when it is tried once more. */
  private readonly noMakerClose = new Set<string>();
  /** Shadow low-cost gate (statistics only): for a task without the gate, what the gate would
   *  have said when the round opened ("CALM" or its code), logged with the round's cost so
   *  "would wait" and "would open" rounds can be compared without delaying any. Memory only. */
  private readonly gateShadow = new Map<string, string>();
  private readonly shadowWatchAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly onEvent?: (e: ExperimentEvent) => void;
  private readonly chain: boolean;
  constructor(private readonly store: OperationsStore<ExperimentCampaign>, private readonly connector: ExperimentConnector, options: ExperimentCoordinatorOptions = {}) {
    this.now = options.now ?? Date.now; this.random = options.random ?? Math.random; this.onEvent = options.onEvent; this.chain = options.chain === true;
  }
  /** Diagnostic trace only: never throws into the engine. */
  private emit(e: ExperimentEvent) { try { this.onEvent?.(e); } catch { /* logging must not affect trading */ } }
  /** Immediate in-memory barrier, before asynchronous persistence or vault lock. */
  halt(): void { this.halted = true; this.generation++; this.lagSince.clear(); this.lookedAt.clear(); this.closeLagSince.clear(); this.statsAt.clear(); this.readAt.clear(); }
  async query(id?: string): Promise<ExperimentCampaign[]> {
    return structuredClone((await this.store.read()).experiments?.filter(c => id === undefined || c.id === id) ?? []);
  }
  private async get(id: string) { const c = (await this.query(id))[0]; if (!c) refuse("EXPERIMENT_MISSING"); return c; }
  private active(c: ExperimentCampaign, t: Token) { return c.hiddenAt === undefined && !this.halted && t.generation === this.generation && c.epoch === t.epoch && ["RUNNING", "EXITING", "ROLLING"].includes(c.state); }
  private async change<T>(id: string, fn: (c: ExperimentCampaign) => T): Promise<T> {
    return this.store.update(s => { const c = s.experiments?.find(c => c.id === id); if (!c) refuse("EXPERIMENT_MISSING"); const value = fn(c); c.updatedAt = this.now(); return value; });
  }
  async create(input: ExperimentCampaignInput): Promise<ExperimentCampaign> {
    const campaign = makeExperimentCampaign(input, this.now());
    await assertExperimentRouteApproval(campaign);
    await this.store.update(s => {
      if (s.experiments?.some(c => c.id === campaign.id)) refuse("EXPERIMENT_ID_EXISTS");
      if (campaign.walletUsePlanId && activeWalletUsePlan(s)?.id !== campaign.walletUsePlanId) refuse("EXPERIMENT_WALLET_PLAN_MISMATCH");
      for (const g of campaign.groups) for (const p of g.pairs) assertWalletPlanPair(s, p.a, p.b);
      assertExperimentWalletsAvailable(s, campaign);
      (s.experiments ??= []).push(campaign);
    });
    return this.get(campaign.id);
  }
  async start(id: string): Promise<ExperimentCampaign> {
    const generation = this.generation;
    await this.store.update(s => {
      const c = s.experiments?.find(c => c.id === id); if (!c) refuse("EXPERIMENT_MISSING");
      if (c.hiddenAt !== undefined) refuse("EXPERIMENT_HIDDEN");
      if (c.state === "COMPLETED") refuse("EXPERIMENT_COMPLETED");
      if (c.walletUsePlanId && activeWalletUsePlan(s)?.id !== c.walletUsePlanId) refuse("EXPERIMENT_WALLET_PLAN_MISMATCH");
      for (const g of c.groups) for (const p of g.pairs) assertWalletPlanPair(s, p.a, p.b);
      assertExperimentWalletsAvailable(s, c);
      // A pause-and-flatten that a crash or lock interrupted continues: it closes what is
      // still open and then stops again (the flag is cleared only when it completes).
      if (c.exitRequested) c.flattenRequested = undefined;
      // Counted for the rehearsal checklist: a pause (or a crash) followed by a continue.
      if (c.state === "STOPPED" || c.state === "PAUSED") c.resumeCount = (c.resumeCount ?? 0) + 1;
      // When it first ran and last (re)started: "created" is not "started" (1.3.4 reports).
      c.firstStartedAt ??= this.now(); c.lastStartedAt = this.now();
      // A start of this task ends any other task's intent to continue by itself (review P1).
      for (const other of s.experiments ?? []) other.resumeAfterRecovery = undefined;
      c.epoch++; c.state = c.exitRequested ? "EXITING" : !isPairRolling(c) && c.rollovers.some(r => r.fromGroupId === c.groups[c.activeGroup]?.id && r.state !== "CREDITED") ? "ROLLING" : "RUNNING";
      c.errorCode = undefined; c.retryAt = undefined; c.retryCount = undefined;
      // "Continue from the breakpoint": a pair with a request whose outcome is still
      // unknown resumes by querying exactly that request before anything else.
      const now = this.now();
      for (const g of c.groups) for (const p of g.pairs) {
        const unknown = p.rounds.some(r => r.orders.some(o => o.state === "UNKNOWN" || o.cancelState === "UNKNOWN"));
        if (unknown) { p.state = "PAUSED"; p.errorCode = "EXPERIMENT_RECOVERY_UNKNOWN"; p.retryAt = now; p.retryCount = 0; }
        else if (p.state === "PAUSED") { p.state = p.rounds.length ? "ACTIVE" : "WAITING"; p.errorCode = undefined; p.retryAt = undefined; p.retryCount = undefined; }
      }
      for (const step of c.rollovers) if (step.state === "PREPARED") step.epoch = c.epoch;
      // A wait for a calm market starts afresh after a pause: paused time is not waiting.
      for (const g of c.groups) for (const p of g.pairs) for (const r of p.rounds)
        if (r.state === "WAITING_OPEN" && r.costWaitSince !== undefined) { r.costWaitSince = undefined; r.costWaitCode = undefined; }
    });
    if (generation !== this.generation) refuse("EXPERIMENT_STOPPED_DURING_START");
    this.emit({ event: "campaign_start", level: "info", campaignId: id });
    this.halted = false;
    const result = await this.get(id);
    if (generation !== this.generation || this.halted) refuse("EXPERIMENT_STOPPED_DURING_START");
    return result;
  }
  /** `interrupted`: stopped by a recovery or a failed start, not by the operator. A task that
   *  was running then keeps (persisted) its intent to continue by itself; an operator Stop
   *  clears that intent (GPT 20-pair R01). */
  async stop(id?: string, options?: { interrupted?: boolean }): Promise<void> {
    this.emit({ event: "campaign_stop", level: "info", campaignId: id ?? "*" });
    this.halt();
    await this.store.update(s => {
      // An operator Stop ends every task's intent to continue by itself (only one task runs at a
      // time; another one flagged earlier must not start by itself later: review P1).
      if (!options?.interrupted) for (const c of s.experiments ?? []) c.resumeAfterRecovery = undefined;
      for (const c of s.experiments ?? []) if (id === undefined || c.id === id) {
      if (c.state === "COMPLETED" || c.state === "CREATED") continue;
      // Only a recovery's stop of a task that was running keeps its intent to continue.
      if (options?.interrupted && ["RUNNING", "EXITING", "ROLLING"].includes(c.state)) c.resumeAfterRecovery = true;
      c.epoch++; c.state = "STOPPED"; c.updatedAt = this.now();
      for (const g of c.groups) for (const p of g.pairs) for (const r of p.rounds) for (const o of r.orders) {
        if (o.state === "PREPARED") { o.state = "ABORTED_UNSENT"; o.payload = ""; }
        else if (o.state === "DISPATCHED") o.state = "UNKNOWN";
        if (o.cancelState === "DISPATCHED") o.cancelState = "UNKNOWN";
      }
      for (const step of c.rollovers) if (step.state === "DISPATCHED") step.state = "UNKNOWN";
    } });
  }
  async requestExit(id: string): Promise<ExperimentCampaign> {
    const generation = ++this.generation;
    await this.change(id, c => { if (c.hiddenAt !== undefined) refuse("EXPERIMENT_HIDDEN"); if (c.state !== "COMPLETED") { c.exitRequested = true; c.flattenRequested = undefined; c.state = "EXITING"; c.epoch++;
      for (const g of c.groups) for (const p of g.pairs) if (p.state === "PAUSED") p.state = p.rounds.length ? "ACTIVE" : "WAITING";
    } });
    const result = await this.get(id);
    // Persisting exit intent never resumes sending. An already stopped session
    // must be allowed to record it, then explicitly pass start() admission.
    // A newer concurrent Stop still wins by changing the generation.
    if (generation !== this.generation) refuse("EXPERIMENT_STOPPED_DURING_EXIT");
    return result;
  }
  /**
   * Ends a stopped (or never started) task for good so its wallets may be emptied, without
   * trading: allowed only when no round is open and no order or transfer is unresolved.
   * The task then reads as ended early and can never resume against money that is gone.
   */
  /** `onProgress` (feedback only): pairs proven flat so far, of all pairs to read. */
  async closeOut(id: string, onProgress?: (done: number, total: number) => void): Promise<ExperimentCampaign> {
    // Every wallet of the task, also of pairs that never traded or whose rounds all finished,
    // must be proven by a fresh account read to hold nothing in this market (a position or
    // order left by hand or by an earlier task counts too): recorded fills alone (e.g. an
    // order that was never seen and so counted as unfilled) must not end a task. A read that
    // fails throws: unknown is never flat.
    const before = await this.get(id);
    if (before.hiddenAt !== undefined) refuse("EXPERIMENT_HIDDEN");
    // What each pair's journal looked like when the account read proved it flat.
    const journal = (p: ExperimentPair) => JSON.stringify([p.state, p.rounds.map(r => [r.id, r.state, r.orders.map(o => [o.id, o.state, o.filledX18, o.cancelState])])]);
    const provenFlat = new Map<string, string>();
    const report = (done: number) => { try { onProgress?.(done, before.groups.reduce((n, g) => n + g.pairs.length, 0)); } catch { /* feedback only */ } };
    if (before.state !== "COMPLETED" && !["RUNNING", "EXITING", "ROLLING"].includes(before.state))
      for (const g of before.groups) for (const p of g.pairs) {
        report(provenFlat.size);
        const flat = this.connector.isFlat ? await this.connector.isFlat(before, p) : await this.connector.preflight(before, p).then(snap =>
          snap.complete && snap.a.positionX18 === "0" && snap.b.positionX18 === "0" && !snap.a.openDigests.length && !snap.b.openDigests.length);
        if (!flat) refuse(p.rounds.some(r => r.state !== "COMPLETED") ? "EXPERIMENT_OPEN_ROUND_EXIT_FIRST" : "EXPERIMENT_WALLETS_NOT_FLAT");
        provenFlat.set(p.id, journal(p));
      }
    await this.change(id, c => {
      if (c.hiddenAt !== undefined) refuse("EXPERIMENT_HIDDEN");
      if (c.state === "COMPLETED") return;
      if (["RUNNING", "EXITING", "ROLLING"].includes(c.state)) refuse("EXPERIMENT_STILL_RUNNING");
      // Every order must be final, its fill known and any cancel confirmed.
      const open = c.groups.some(g => g.pairs.some(p => p.rounds.some(r => r.orders.filter(o => o.state !== "ABORTED_UNSENT")
        .some(o => o.state !== "TERMINAL" || (r.state !== "COMPLETED" && !o.factKnown) || (o.cancelState !== undefined && o.cancelState !== "CONFIRMED")))));
      if (open) refuse("EXPERIMENT_OPEN_ROUND_EXIT_FIRST");
      // A proof belongs to the journal it was read against. A pair whose rounds or orders
      // changed meanwhile (or that was not read) needs a new read: press again. A pair the
      // read proved flat holds nothing even when its journal nets to a position (e.g. one
      // closed by hand on the Nado site).
      if (c.groups.some(g => g.pairs.some(p => provenFlat.get(p.id) !== journal(p)))) refuse("EXPERIMENT_CLOSE_STATE_CHANGED");
      if (c.rollovers.some(s => s.state === "DISPATCHED" || s.state === "UNKNOWN")) refuse("EXPERIMENT_ROLLOVER_PENDING");
      c.exitRequested = true; c.state = "COMPLETED"; c.epoch++;
      for (const g of c.groups) for (const p of g.pairs) if (p.state !== "COMPLETED") { p.state = "COMPLETED"; p.retryAt = undefined; }
    });
    return this.get(id);
  }
  /**
   * Pause with everything closed: no new rounds, resting orders are withdrawn and every
   * open position of the active group is closed by taker orders; when all pairs are flat
   * the task stops and can later continue from there. Only while the task is running.
   */
  async requestFlatten(id: string): Promise<ExperimentCampaign> {
    // Revoke every old send permit synchronously, including a dispatch queued behind
    // the global trade lock. The next pass uses the new generation and may still close.
    const generation = ++this.generation;
    await this.change(id, c => {
      if (c.hiddenAt !== undefined) refuse("EXPERIMENT_HIDDEN");
      if (!["RUNNING", "EXITING", "ROLLING"].includes(c.state)) refuse("EXPERIMENT_NOT_RUNNING");
      // Between groups everything is already flat and money is moving: nothing to close.
      if (c.state === "ROLLING" || livePairs(c).every(p => p.state === "COMPLETED")) refuse("EXPERIMENT_ALREADY_FLAT_ROLLING");
      if (c.exitRequested) return;
      c.flattenRequested = true;
      this.emit({ event: "flatten_requested", level: "info", campaignId: id });
      for (const g of c.groups) for (const p of g.pairs) if (p.state === "PAUSED" && p.rounds.length) { p.state = "ACTIVE"; p.retryAt = undefined; }
    });
    if (generation !== this.generation) refuse("EXPERIMENT_STOPPED_DURING_FLATTEN");
    return this.get(id);
  }
  /**
   * Stops the tasks and looks up every open request. `allowed` is the caller's session:
   * a recovery started for a session that has since been halted and replaced must not
   * stop (or write anything for) the newer one, so it is checked right before each step.
   */
  async recover(id?: string, allowed: () => boolean = () => true): Promise<void> {
    if (!allowed()) refuse("STOPPED");
    await this.stop(id, { interrupted: true });
    if (!allowed()) refuse("STOPPED");
    await this.reconcile(id);
  }
  /** Read-only remote recovery: never signs, cancels, dispatches or rolls funds. */
  /** `onProgress` (feedback only): open requests looked up so far, of all to look up. */
  async reconcile(id?: string, onProgress?: (done: number, total: number) => void): Promise<ExperimentCampaign[]> {
    if (this.busy || this.lanes.size) refuse("EXPERIMENT_BUSY");
    this.busy = true; this.reconciling = true;
    try {
    for (const c of await this.query(id)) {
      // Pairs are looked up over FINISH_LANES lanes; within a pair its orders stay in order.
      // Lookups only: a failed one pauses its own pair.
      const pairs = c.groups.flatMap(g => g.pairs).filter(p => p.rounds.some(r => r.orders.some(o => o.state === "UNKNOWN" || o.state === "DISPATCHED" || o.cancelState === "UNKNOWN")));
      const open = (o: ExperimentOrder) => o.state === "UNKNOWN" || o.state === "DISPATCHED" || o.cancelState === "UNKNOWN";
      const total = pairs.reduce((n, p) => n + p.rounds.reduce((m, r) => m + r.orders.filter(open).length, 0), 0) + c.rollovers.filter(s => s.state === "UNKNOWN" || s.state === "DISPATCHED").length;
      let looked = 0;
      const report = () => { try { onProgress?.(looked, total); } catch { /* feedback only */ } };
      report();
      // All lanes have ended before this returns (or throws): no lookup outlives the pass.
      await runLanes(pairs, FINISH_LANES, async (p) => {
        for (const r of p.rounds) for (const o of r.orders) if (o.state === "UNKNOWN" || o.state === "DISPATCHED" || o.cancelState === "UNKNOWN") {
          try { await this.applyFact(c.id, p.id, r.id, o.id, await this.connector.lookup(c, o)); }
          catch { await this.pause(c.id, p.id, "EXPERIMENT_RECOVERY_UNKNOWN"); }
          looked++; report();
        }
      });
      for (const step of c.rollovers) if (step.state === "UNKNOWN" || step.state === "DISPATCHED") {
        try { await this.rollFact(c.id, step.id, await this.connector.lookupRollover(c, step)); }
        catch { await this.pause(c.id, undefined, "EXPERIMENT_ROLLOVER_UNKNOWN"); }
        looked++; report();
      }
    }
    } finally { this.busy = false; this.reconciling = false; }
    return this.query(id);
  }
  /**
   * A pair pauses alone and the task keeps running; it retries itself after a minute
   * (network-type errors indefinitely, others a few times) and then only queries its
   * original requests first. A group-step failure keeps the task's state and retries the
   * step; only errors that need the operator stop the task.
   */
  private async pause(id: string, pairId: string | undefined, code: string, token?: Token) {
    return this.change(id, c => {
      if(token&&!this.active(c,token))return;
      this.emit({ event: pairId ? "pair_paused" : "campaign_paused", level: isTransientExperimentError(code) ? "warn" : "error", campaignId: id, pairId, data: { code } });
      const now = this.now(), p = pairId === undefined ? undefined : c.groups.flatMap(g => g.pairs).find(p => p.id === pairId);
      if (p) {
        // Network-type pauses retry indefinitely and do not use up the review budget.
        p.state = "PAUSED"; p.errorCode = code; if (!isTransientExperimentError(code)) p.retryCount = (p.retryCount ?? 0) + 1;
        // A rate limit only needs a short breath: a round in progress must not wait a minute.
        p.retryAt = experimentAutoRetry(code, p.retryCount ?? 0) ? now + experimentRetryDelay(code, p.retryCount ?? 0) : undefined;
        // Kept failing the same non-network way: wound down (close-only), then set aside,
        // so the group (and every later group, the return to F and the end of the task)
        // never waits on it for long (see PAIR_LONELY_MS / PAIR_CLOSE_ONLY_MS).
        if (!isTransientExperimentError(code) && ["RUNNING", "EXITING"].includes(c.state)) {
          if (p.closeOnlyAt === undefined && (p.retryCount ?? 0) >= EXPERIMENT_SET_ASIDE_AFTER) this.closeOnly(id, p, code, now);
          else if (p.closeOnlyAt !== undefined && now - p.closeOnlyAt >= PAIR_CLOSE_ONLY_MS) { this.setAside(id, p, code, now); return; }
        }
        // Never hides a campaign-level reason (e.g. a cost-limit exit) that is not a retry.
        // A notice only: the pair keeps retrying by itself (see experimentAutoRetry).
        if ((p.retryAt === undefined || experimentNeedsReview(code, p.retryCount ?? 0)) && c.state !== "STOPPED" && c.state !== "COMPLETED" && (c.errorCode === undefined || isTransientExperimentError(c.errorCode))) c.errorCode = "EXPERIMENT_PAIR_NEEDS_REVIEW";
        return;
      }
      c.errorCode = code;
      // Network-type failures never use up the count (as for pairs).
      const attempts = (c.retryCount ?? 0) + (isTransientExperimentError(code) ? 0 : 1);
      // A group transfer (ROLLING) is query-first and nonce-guarded: retried every minute.
      if (["RUNNING", "EXITING", "ROLLING"].includes(c.state) && experimentAutoRetry(code, attempts)) { c.retryCount = attempts || undefined;
        c.retryAt = now + (code === "EXPERIMENT_ROLLOVER_UNKNOWN" ? ROLLOVER_RETRY_MS : c.state === "ROLLING" ? EXPERIMENT_RETRY_MS : experimentRetryDelay(code, attempts)); }
      else if (c.state !== "STOPPED" && c.state !== "COMPLETED") { c.state = "PAUSED"; c.retryAt = undefined; }
    });
  }
  /** Stage 1: this pair only closes what it holds from now on (retried at once). */
  private closeOnly(id: string, p: ExperimentPair, code: string, now: number) {
    p.closeOnlyAt = now; p.closeOnlyCode = code; p.retryAt = now;
    this.emit({ event: "pair_close_only", level: "warn", campaignId: id, pairId: p.id, data: { code } });
  }
  /** Stage 2: set aside; the group no longer waits on it (its wallets keep their money). */
  private setAside(id: string, p: ExperimentPair, code: string, now: number) {
    p.state = "COMPLETED"; p.retryAt = undefined; p.setAsideAt = now; p.setAsideCode = p.closeOnlyCode ?? code; p.errorCode = "EXPERIMENT_PAIR_SET_ASIDE";
    this.emit({ event: "pair_set_aside", level: "error", campaignId: id, pairId: p.id, data: { code: p.setAsideCode } });
  }
  /** Operator: a pair set aside (or wound down) in the active group trades again; it retries at
   *  once and, if its cause is still there, goes through the same two stages again. */
  async rejoinPair(id: string, pairId: string): Promise<void> {
    await this.change(id, c => {
      if (!["RUNNING", "EXITING", "PAUSED", "STOPPED"].includes(c.state)) refuse("EXPERIMENT_PAIR_REJOIN_NOT_ALLOWED");
      const p = pairById(c, pairId);
      if (!p || (p.setAsideAt === undefined && p.closeOnlyAt === undefined)) refuse("EXPERIMENT_PAIR_REJOIN_NOT_ALLOWED");
      if (p.setAsideCode === SOURCE_SET_ASIDE) refuse("EXPERIMENT_PAIR_REJOIN_NOT_ALLOWED");
      if (isPairRolling(c)) {
        // The source is reserved as soon as its immutable outgoing step exists.
        // A pending handoff must never race a reopened round on the same capital.
        if (p.handedOffAt !== undefined || outgoingStep(c, p)) refuse("EXPERIMENT_PAIR_REJOIN_NOT_ALLOWED");
        // Pair rolling: a pair (or a pair downstream waiting on it) routed back to F whose group's
        // returns step already exists could never be handed off again: not rejoined.
        const chain = [p]; if (!p.catchUp) for (let q = targetPair(c, p.id); q && q.setAsideCode === SOURCE_SET_ASIDE; q = targetPair(c, q.id)) chain.push(q);
        if (chain.some(q => !targetPair(c, q.id) && c.rollovers.some(s => s.id === returnsStepId(c, pairPlace(c, q.id)!.group)))) refuse("EXPERIMENT_PAIR_REJOIN_NOT_ALLOWED");
      } else {
        // Whole group: the group's step, once it exists, moves only the pairs not set aside at
        // the time; rejoining one before it is credited would change its rows (audit of 1.5).
        const group = c.groups.find(g => g.pairs.some(q => q.id === p.id));
        if (group && c.rollovers.some(s => s.fromGroupId === group.id && s.state !== "CREDITED")) refuse("EXPERIMENT_PAIR_REJOIN_NOT_ALLOWED");
      }
      // A flat pair joins the admission queue; only unfinished work retains a slot.
      p.state = isPairRolling(c) && !unfinishedPair(p) ? "WAITING" : "PAUSED"; p.retryAt = p.state === "PAUSED" ? this.now() : undefined; p.retryCount = undefined; p.errorCode = undefined;
      p.setAsideAt = undefined; p.setAsideCode = undefined; p.closeOnlyAt = undefined; p.closeOnlyCode = undefined; p.lonelySince = undefined;
      // Pair rolling: the pairs waiting on this one's money wait again instead of staying ended
      // (not in the end-of-task pass: such a pair hands nothing on).
      if (!p.catchUp) for (let q = targetPair(c, p.id); q && q.setAsideCode === SOURCE_SET_ASIDE; q = targetPair(c, q.id)) {
        q.state = "WAITING"; q.setAsideAt = undefined; q.setAsideCode = undefined; q.errorCode = undefined;
      }
    });
  }
  private draw() { const n = this.random(); if (!Number.isFinite(n) || n < 0 || n >= 1) refuse("EXPERIMENT_RANDOM_INVALID"); return n; }
  private makeRound(c: ExperimentCampaign, p: ExperimentPair): ExperimentRound {
    // The task's slot (3 minutes for tasks made since 1.3.4; none: 5 minutes, as before).
    const time = slotTiming(c.slotMs);
    const now = this.now(), slot = Math.ceil(now / time.slotMs) * time.slotMs, number = (p.archivedRoundCount ?? 0) + p.rounds.length + 1;
    const round: ExperimentRound = { id: `${c.id}:${p.id}:${number}`, number, openAt: slot + Math.floor(this.draw() * time.openOffsetMs),
      side: this.draw() < 0.5 ? "BUY" : "SELL", holdMs: time.holdMinMs + Math.floor(this.draw() * (time.holdRandomMs + 1)), state: "WAITING_OPEN", orders: [],
      ...(c.slotMs !== undefined ? { slotMs: c.slotMs } : {}) };
    if (c.sizing) {
      // Fixed when drawn: a restart resumes this exact plan instead of resizing it from
      // equity that already contains this round's open position.
      const a = c.wallets[p.a]!, b = c.wallets[p.b]!;
      if (a.baselineEquityX18 === undefined || b.baselineEquityX18 === undefined) refuse("EXPERIMENT_CAPITAL_UNKNOWN");
      const input = { capitalA: signed(a.baselineEquityX18), capitalB: signed(b.baselineEquityX18),
        filledA: BigInt(a.quoteFilledX18), filledB: BigInt(b.quoteFilledX18), targetPerWallet: BigInt(c.targetNotionalPerWalletX18), sizing: c.sizing };
      const plan = pairRoundTurnover(input);
      if (plan.roundTurnover <= 0n) refuse("EXPERIMENT_SIZING_INVALID");
      // The approved single-order cap is part of the confirmed plan, never raised at run time.
      if (plan.openNotional > BigInt(c.orderNotionalX18)) refuse("EXPERIMENT_PLAN_ORDER_CAP");
      round.plannedTurnoverX18 = String(plan.roundTurnover);
      // Catch-up: a pair at least one full round behind the group's leading pair runs a
      // larger round (up to catchUpPercent, never above the confirmed single-order cap), so
      // the whole group is not held back by its slowest pairs.
      // A pair in the end-of-task catch-up pass always runs at twice the usual size.
      // Pair rolling: no pair waits for another, so only the end-of-task pass is boosted.
      const percent = p.catchUp ? 200 : isPairRolling(c) ? 100 : c.catchUpPercent ?? 100;
      if (percent > 100) {
        const progress = (q: ExperimentPair) => { const x = BigInt(c.wallets[q.a]!.quoteFilledX18), y = BigInt(c.wallets[q.b]!.quoteFilledX18); return x < y ? x : y; };
        const leader = c.groups[c.activeGroup]!.pairs.reduce((m, q) => progress(q) > m ? progress(q) : m, 0n);
        if (p.catchUp || leader - progress(p) >= plan.baseTurnover) {
          const boosted = pairRoundTurnover({ ...input, boostPercent: percent });
          const cap = 2n * BigInt(c.orderNotionalX18), turnover = boosted.roundTurnover < cap ? boosted.roundTurnover : cap;
          if (turnover > plan.roundTurnover) { round.unboostedTurnoverX18 = String(plan.roundTurnover); round.plannedTurnoverX18 = String(turnover); }
        }
      }
    }
    return round;
  }
  private async snapshot(c: ExperimentCampaign, p: ExperimentPair, updateTradingRisk = true, force = false): Promise<ExperimentPairSnapshot> {
    const fact = await this.account(c, p);
    // Ended groups are only queried for flatness while transfers are pending.
    // Equity debits from rollover are capital flows, not trading losses.
    if (updateTradingRisk) await this.recordStats(c, p, fact, force);
    return fact;
  }
  /** One validated account read of both wallets. */
  private async account(c: ExperimentCampaign, p: ExperimentPair): Promise<ExperimentPairSnapshot> {
    const fact = await this.connector.preflight(c, p), now = this.now();
    if (!fact.complete || !Number.isSafeInteger(fact.observedAt) || fact.observedAt > now || now - fact.observedAt > 10000 ||
      owner(fact.a.owner) !== p.a || owner(fact.b.owner) !== p.b || !Array.isArray(fact.a.openDigests) || !Array.isArray(fact.b.openDigests)) refuse("EXPERIMENT_ACCOUNT_UNKNOWN");
    signed(fact.a.positionX18); signed(fact.b.positionX18);
    this.readAt.set(this.key(c, p), now);
    return fact;
  }
  /**
   * Equity, result and limits from a read. Limits are checked on every read; the statistics
   * are written at most every STATS_WRITE_MS (each write is a full journal save that every
   * pair's orders queue behind), at once for a first baseline or a limit reached, and always
   * when `force`d (the flat proof of a round and the end of a group, so the results kept are
   * the final ones). Whether it wrote.
   */
  private async recordStats(c: ExperimentCampaign, p: ExperimentPair, fact: ExperimentPairSnapshot, force: boolean): Promise<boolean> {
    if (fact.a.equityX18 === null || fact.b.equityX18 === null) refuse("EXPERIMENT_EQUITY_UNKNOWN");
    const key = this.key(c, p);
    const inflow = await this.hubInflowRaw(c, p);
    if (!force && this.elapsed(this.statsAt.get(key)) < STATS_WRITE_MS && !this.statsUrgent(c, fact, inflow)) return false;
    await this.change(c.id, current => {
      for (const w of [fact.a, fact.b]) {
        const a = owner(w.owner), stat = current.wallets[a]!;
        if (w.equityX18 === null) refuse("EXPERIMENT_EQUITY_UNKNOWN");
        const equity = signed(w.equityX18);
        if (stat.baselineEquityX18 === undefined) {
          if (signed(w.positionX18) !== 0n || w.openDigests.length) refuse("EXPERIMENT_BASELINE_NOT_FLAT");
          stat.baselineEquityX18 = String(equity);
          if (inflow !== undefined && a === current.route?.fundingAccount) stat.baselineHubInflowRaw = String(inflow);
        }
        const pnl = hubAdjustedPnl(current, a, equity, stat, inflow);
        stat.equityX18 = String(equity); stat.netPnlX18 = String(pnl); stat.lossX18 = String(pnl < 0n ? -pnl : 0n);
        // Absent thresholds are off: costs above are still recorded, nothing exits early.
        if ((current.maxLossPerWalletX18 !== undefined && BigInt(stat.lossX18) > 0n && BigInt(stat.lossX18) >= BigInt(current.maxLossPerWalletX18)) ||
          (current.maxFeePerWalletX18 !== undefined && BigInt(stat.feePaidX18) > 0n && BigInt(stat.feePaidX18) >= BigInt(current.maxFeePerWalletX18))) {
          if (!current.exitRequested) { current.exitRequested = true; current.epoch++;
            for (const g of current.groups) for (const q of g.pairs) if (q.state === "PAUSED") { q.state = q.rounds.length ? "ACTIVE" : "WAITING"; q.retryAt = undefined; } }
          if (!["STOPPED", "PAUSED", "COMPLETED"].includes(current.state)) current.state = "EXITING";
          current.errorCode = "EXPERIMENT_COST_LIMIT_EXIT";
        }
      }
    });
    this.statsAt.set(key, this.now());
    return true;
  }
  /** A read that must be written now: a wallet's first baseline, or a loss or fee limit
   *  reached (the same test as the write itself). */
  private statsUrgent(c: ExperimentCampaign, fact: ExperimentPairSnapshot, inflow?: bigint): boolean {
    return [fact.a, fact.b].some(w => {
      const stat = c.wallets[owner(w.owner)];
      if (!stat || stat.baselineEquityX18 === undefined) return true;
      const pnl = hubAdjustedPnl(c, owner(w.owner), signed(w.equityX18), stat, inflow), loss = pnl < 0n ? -pnl : 0n;
      return (c.maxLossPerWalletX18 !== undefined && loss > 0n && loss >= BigInt(c.maxLossPerWalletX18)) ||
        (c.maxFeePerWalletX18 !== undefined && BigInt(stat.feePaidX18) > 0n && BigInt(stat.feePaidX18) >= BigInt(c.maxFeePerWalletX18));
    });
  }
  /** Hub (1.5): what the hub's DDA has been credited by returns (proven payouts), when this
   *  pair holds the hub; else undefined. Read only. */
  private async hubInflowRaw(c: ExperimentCampaign, p: ExperimentPair): Promise<bigint | undefined> {
    const hub = c.route?.hub ? c.route.fundingAccount : undefined;
    if (!hub || (p.a !== hub && p.b !== hub)) return undefined;
    // [Phase-A stub] Hub inflow was summed from the dropped `collateral` desk field (hub
    // funding is deferred — Phase C). A hub route cannot be configured under the benchmark
    // (no route), so `hub` is always undefined above and this branch is unreachable; return
    // 0 (no credited returns) to keep the inert hub path type-correct.
    return 0n;
  }
  private key(c: ExperimentCampaign, p: ExperimentPair) { return c.id + "\n" + p.id; }
  /** Wall-clock rollback expires a hint/cache instead of extending it into the future. */
  private elapsed(at: number | undefined) { const delta = this.now() - (at ?? -Infinity); return delta < 0 ? Infinity : delta; }
  private closeNonfinalExpired(c:ExperimentCampaign,o:ExperimentOrder):boolean {
    const key=`${c.id}:${c.epoch}:${o.id}`,now=this.now(),seen=this.closeLagSince.get(key),filled=BigInt(o.filledX18);
    // This is a bound on a stalled original close, not on journal/reader queue time.
    // A freshly confirmed increase in cumulative executed quantity starts a new
    // bounded wait for final accounting. It never authorizes a replacement order.
    // Repeated answers or fee/quote-only changes cannot extend the wait.
    if(!seen||now<seen.since||filled>seen.filled){
      if(this.closeLagSince.size>=512&&!this.closeLagSince.has(key))this.closeLagSince.delete(this.closeLagSince.keys().next().value!);
      this.closeLagSince.set(key,{since:now,filled});return false;
    }
    return now-seen.since>=FACT_LAG_MS;
  }
  /** Hint only (see ExperimentConnector.urgent); never affects what is read or sent. */
  private urgent(c: ExperimentCampaign, p: ExperimentPair, on: boolean) { try { void Promise.resolve(this.connector.urgent?.(c, p, on)).catch(() => {}); } catch { /* a hint */ } }
  /** Hints must be synchronous true; a throwing/async implementation cannot affect facts. */
  private hint(read: () => unknown): boolean {
    try { const value = read(); if (value && typeof (value as { then?: unknown }).then === "function") void Promise.resolve(value).catch(() => {}); return value === true; }
    catch { return false; }
  }
  private async phase(id: string, pairId: string, roundId: string, state: ExperimentRound["state"], t: Token) {
    this.emit({ event: "round_phase", level: "info", campaignId: id, pairId, data: { round: roundId.split(":").pop(), state } });
    await this.change(id, c => { if (!this.active(c, t)) return;
      const r = c.groups.flatMap(g => g.pairs).find(p => p.id === pairId)?.rounds.find(r => r.id === roundId); if (r) r.state = state; });
  }
  private async applyFact(id: string, pairId: string, roundId: string, orderId: string, fact: ExperimentOrderFact): Promise<void> {
    // A confirmed original execution is cumulative evidence, not a position quote.
    // Judge response freshness on receipt, before waiting for the journal writer.
    // Keep a snapshot and still reject a future timestamp after a clock rollback.
    fact = { ...fact };
    const receivedAt = this.now();
    // A lookup that only repeats what is already recorded (a resting maker polled again) is
    // not written: each write is a full journal save that every pair's orders queue behind
    // (audit N5). Only a fresh, matching, unchanged, non-final fact is skipped; anything else
    // (new fill, final, a cancel to clear, a stale or mismatched answer) goes through below.
    {
      const now = await this.store.read(), c = now.experiments?.find(c => c.id === id), r = c?.groups.flatMap(g => g.pairs).find(p => p.id === pairId)?.rounds.find(r => r.id === roundId), o = r?.orders.find(o => o.id === orderId);
      if (o && r && fact.known && fact.identityMatches && fact.digest === o.digest && !fact.terminal && o.state === "DISPATCHED" && o.factKnown &&
        fact.quoteFilledX18 !== null && fact.feePaidX18 !== null && Number.isSafeInteger(fact.observedAt) && fact.observedAt <= receivedAt && receivedAt - fact.observedAt <= 10000 &&
        [fact.filledX18, fact.quoteFilledX18, fact.feePaidX18].every(v => typeof v === "string" && v.length <= 78 && /^(0|[1-9][0-9]*)$/.test(v)) &&
        BigInt(fact.filledX18) === BigInt(o.filledX18) && BigInt(fact.quoteFilledX18) === BigInt(o.quoteFilledX18) && BigInt(fact.feePaidX18) === BigInt(o.feePaidX18) &&
        !(o.cancelState === "UNKNOWN" && fact.resting) &&
        !now.orders.some(row => row.chainId === o.chainId && row.owner === o.owner && row.digest === o.digest && row.filledX18 !== o.filledX18) &&
        !(o.role === "A_OPEN" && BigInt(o.filledX18) > 0n && r.sourceFilledAt === undefined) &&
        !(o.role === "B_CLOSE" && o.postOnly && BigInt(o.filledX18) > 0n && r.closeSourceFilledAt === undefined)) return;
    }
    await this.store.update(s => {
      const c = s.experiments?.find(c => c.id === id), p = c?.groups.flatMap(g => g.pairs).find(p => p.id === pairId), r = p?.rounds.find(r => r.id === roundId), o = r?.orders.find(o => o.id === orderId);
      if (!c || !o) refuse("EXPERIMENT_ORDER_MISSING");
      if (!fact.known || !fact.identityMatches || fact.digest !== o.digest || fact.quoteFilledX18 === null || fact.feePaidX18 === null ||
        !Number.isSafeInteger(fact.observedAt) || fact.observedAt > receivedAt || fact.observedAt > this.now() || receivedAt - fact.observedAt > 10000) refuse("EXPERIMENT_ORDER_FACT_UNKNOWN");
      const qty = rawAmount(fact.filledX18), quote = rawAmount(fact.quoteFilledX18), fee = rawAmount(fact.feePaidX18);
      if (qty > BigInt(o.quantityX18) || qty < BigInt(o.filledX18) || quote < BigInt(o.quoteFilledX18) || fee < BigInt(o.feePaidX18) || (o.state === "TERMINAL" && !fact.terminal)) refuse("EXPERIMENT_ORDER_FACT_REGRESSED");
      const stat = c.wallets[o.owner]!;
      stat.quoteFilledX18 = String(BigInt(stat.quoteFilledX18) + quote - BigInt(o.quoteFilledX18));
      stat.feePaidX18 = String(BigInt(stat.feePaidX18) + fee - BigInt(o.feePaidX18));
      o.filledX18 = String(qty); o.quoteFilledX18 = String(quote); o.feePaidX18 = String(fee); o.factKnown = true;
      // For the follow-time statistics: when A's opening was first seen filled.
      if (o.role === "A_OPEN" && qty > 0n && r!.sourceFilledAt === undefined) r!.sourceFilledAt = fact.observedAt;
      // Likewise on the way out: when B's maker close was first seen filled.
      if (o.role === "B_CLOSE" && o.postOnly && qty > 0n && r!.closeSourceFilledAt === undefined) r!.closeSourceFilledAt = fact.observedAt;
      o.state = fact.terminal ? "TERMINAL" : "DISPATCHED";
      if (fact.terminal) { o.payload = ""; if (o.cancelState) o.cancelState = "CONFIRMED"; }
      // Proven still resting after a cancel whose answer was lost: cancelling by digest is
      // idempotent, so the cancel may be claimed and sent again instead of polling forever.
      // Any other non-terminal fact (e.g. an archived partial fill) proves nothing about it.
      else if (o.cancelState === "UNKNOWN" && fact.resting) o.cancelState = undefined;
      const protectedOrder = s.orders.find(row => row.chainId === o.chainId && row.owner === o.owner && row.digest === o.digest);
      if (protectedOrder) { protectedOrder.filledX18 = o.filledX18; if (fact.terminal) protectedOrder.cleared = true; }
      c.updatedAt = this.now();
    });
  }
  private async poll(c: ExperimentCampaign, p: ExperimentPair, r: ExperimentRound, o: ExperimentOrder, t: Token): Promise<ExperimentOrder | undefined> {
    if (o.state === "TERMINAL") return o;
    try {
      const fact = await this.connector.lookup(c, o);
      if(!this.active(await this.get(c.id),t))return;
      this.lookedAt.set(o.id, this.now());
      if (this.lagging(o, fact)) return;
      await this.applyFact(c.id, p.id, r.id, o.id, fact);
    }
    catch { if(!this.active(await this.get(c.id),t))return; this.lagSince.delete(o.id); await this.change(c.id, current => { const row = current.groups.flatMap(g => g.pairs).flatMap(p => p.rounds).flatMap(r => r.orders).find(row => row.id === o.id); if (this.active(current,t)&&row && row.state !== "TERMINAL") row.state = "UNKNOWN"; }); await this.pause(c.id, p.id, "EXPERIMENT_LOOKUP_UNKNOWN",t); return; }
    const row = (await this.get(c.id)).groups.flatMap(g => g.pairs).flatMap(p => p.rounds).flatMap(r => r.orders).find(row => row.id === o.id);
    if (row?.state === "TERMINAL") this.lookedAt.delete(o.id);
    return row;
  }
  /**
   * The exchange took this order (its send was answered) but its history does not show the
   * fill yet: the history lags the exchange by about a second, so a lookup made right after
   * a fill (which the faster steps now do) often lands in that gap. The pair does not pause:
   * the order keeps its state and is looked up again on the next step, until FACT_LAG_MS and
   * FACT_LAG_TRIES have both passed (then it pauses as before). Nothing is sent meanwhile for
   * this order's round step.
   */
  private lagging(o: ExperimentOrder, fact: ExperimentOrderFact): boolean {
    if (fact.known || !fact.identityMatches || fact.digest !== o.digest || o.state !== "DISPATCHED") { this.lagSince.delete(o.id); return false; }
    const lag = this.lagSince.get(o.id) ?? { since: this.now(), count: 0 };
    lag.count++; this.lagSince.set(o.id, lag);
    if (lag.count < FACT_LAG_TRIES || this.now() - lag.since < FACT_LAG_MS) return true;
    this.lagSince.delete(o.id); return false;
  }
  /** A resting maker is re-posted when it is no longer at the best price (like a market
   *  maker keeping the top of book), or when it nears its signed expiry. Without a book
   *  reader the plan's fixed maker timeout applies. */
  private async makerDue(c: ExperimentCampaign, o: ExperimentOrder): Promise<boolean> {
    const age = this.now() - o.createdAt;
    if (!this.connector.makerStale) return age >= (c.makerTimeoutMs ?? 30000);
    if (age >= MAKER_MAX_AGE_MS) return true;
    // A just-placed order gets a moment to show on the book before it is judged.
    if (age < 2000) return false;
    try { return await this.connector.makerStale(c, o); } catch { return false; }
  }
  private minimumHedge(o: ExperimentOrder): bigint {
    const minimum = rawAmount(o.minimumHedgeQuantityX18 ?? "1"); return minimum > 0n ? minimum : 1n;
  }
  private async sourceBelowMinimumExit(c: ExperimentCampaign, p: ExperimentPair, r: ExperimentRound, t: Token, followerMargin = false): Promise<void> {
    await this.change(c.id, current => { if (!this.active(current, t)) return;
      const round = current.groups.flatMap(g => g.pairs).find(pair => pair.id === p.id)!.rounds.find(round => round.id === r.id)!;
      // A follower remainder below the market minimum after a partial follow is a follow
      // shortfall, not a too-small source fill.
      round.earlyExitReason = round.orders.some(o => o.role === "B_OPEN" && BigInt(o.filledX18) > 0n) || followerMargin ? "FOLLOWER_INCOMPLETE_EXIT" : "SOURCE_BELOW_MINIMUM_EXIT"; round.state = "A_CLOSE";
    });
  }
  private async advanceFinalSource(c: ExperimentCampaign, p: ExperimentPair, r: ExperimentRound, o: ExperimentOrder, t: Token): Promise<void> {
    if (o.state !== "TERMINAL" || !o.factKnown) refuse("EXPERIMENT_SOURCE_NOT_FINAL");
    if (winding(c, p)) { await this.phase(c.id, p.id, r.id, "A_CLOSE", t); return; }
    const filled = BigInt(o.filledX18);
    if (filled > 0n && filled < this.minimumHedge(o)) { await this.sourceBelowMinimumExit(c, p, r, t); return; }
    // Nothing filled yet and the window is still open: re-post at the current best price.
    if (!filled && this.now() < openWindowEnd(r)) { await this.phase(c.id, p.id, r.id, "A_OPEN", t); return; }
    await this.phase(c.id, p.id, r.id, filled ? "B_OPEN" : "VERIFYING_FLAT", t);
  }
  /** A deposit of this pair that is not settled holds its new openings. Audit F02: a row
   *  without a credit proof is not "no conflict" - a pair set aside before its first deposit
   *  was credited (and later let back in by the catch-up pass, or by the operator) would open
   *  on a deposit whose request may still be UNKNOWN. Same rule as the start check: settled =
   *  completed, or ready under the task's parallel policy; a request that never moved money
   *  (REVERTED, ABORTED_UNSENT) holds nothing. */
  private async depositConflict(_c: ExperimentCampaign, _p: ExperimentPair): Promise<boolean> {
    // [Phase-A stub] A pre-funded cohort has no in-flight first deposits to conflict with
    // (funding is deferred — Phase C; the dropped `onboarding`/`funding` desk fields this
    // scanned no longer exist). Nothing holds a pair back on deposit grounds.
    return false;
  }
  private async place(c: ExperimentCampaign, p: ExperimentPair, r: ExperimentRound, role: ExperimentOrderRole, quantity: string | undefined, t: Token, forceIoc = false, maker = false): Promise<void> {
    const close = role.endsWith("CLOSE"), a = role.startsWith("A_"), side = role === "A_OPEN" || role === "B_CLOSE" ? r.side : opposite(r.side);
    if (!this.active(c, t) || (winding(c, p) && !close)) return;
    // A pair whose deposit is not settled (never credited, or its proof turned unknown or
    // contradicted) opens no new round. Closes and B's follow of an A fill already made are
    // never held here (no unhedged position is left behind).
    if (role === "A_OPEN" && (c.mode === "LIVE" || c.fundingReadiness) && await this.depositConflict(c, p)) { await this.pause(c.id, p.id, "EXPERIMENT_FUNDING_EVIDENCE_CONFLICT", t); return; }
    // Closes and the follower open may take further attempts for the real remainder;
    // A's maker open is re-posted only after an attempt that filled nothing.
    const repeatable = close || role === "B_OPEN" || role === "A_OPEN";
    // Closes have no attempt cap: each one is reduce-only for the freshly read position,
    // so retrying until flat can never open or flip a position.
    if (role === "B_OPEN" && r.orders.filter(o => o.role === role && o.state !== "ABORTED_UNSENT").length >= FOLLOW_ATTEMPTS) refuse("EXPERIMENT_FOLLOW_ATTEMPTS_EXHAUSTED");
    const windowEnd = openWindowEnd(r);
    const attempt = r.orders.filter(o => o.role === role).length + 1;
    // All new closes carry native reduce-only, including B's maker. The official
    // appendix docs show this combination. A venue rejecting it with 2067 takes
    // the existing safe IOC exit below; it NEVER retries without reduce-only.
    const bMaker = role === "B_CLOSE" && maker;
    const request: ExperimentOrderRequest = { id: `experiment:${c.id}:${p.id}:${r.number}:${role}:${attempt}`, role, owner: a ? p.a : p.b, side,
      postOnly: bMaker || (a && !forceIoc), reduceOnly: close };
    if (quantity !== undefined) request.quantityX18 = quantity;
    else if (c.sizing) {
      if (!r.plannedTurnoverX18) refuse("EXPERIMENT_SIZING_INVALID");
      request.notionalX18 = String(BigInt(r.plannedTurnoverX18) / 2n);
      if (r.unboostedTurnoverX18 && role === "A_OPEN") request.minNotionalX18 = String(BigInt(r.unboostedTurnoverX18) / 2n);
    } else request.notionalX18 = c.orderNotionalX18;
    // Each further taker attempt widens the price bound a step (the connector caps it).
    const takerTries = r.orders.filter(o => o.role === role && o.state !== "ABORTED_UNSENT" && !o.postOnly).length;
    if (!request.postOnly && takerTries > 0) request.slippageBps = Math.min(100, c.slippageBps * Math.min(takerTries + 1, 5));
    let prepared: Awaited<ReturnType<ExperimentConnector["prepare"]>>;
    try { prepared = await this.connector.prepare(c, p, request); }
    catch (error) {
      // This exact local prepare refusal precedes any claim/dispatch. A transport
      // error or a refusal after claim never enters this close-only shortcut.
      const code = error instanceof Error ? error.message : undefined;
      // B cannot follow (below the minimum, or its margin cannot carry A's fill): A's
      // position is closed at once instead of waiting unhedged for a retry.
      if (role === "B_OPEN" && (code === "EXPERIMENT_BELOW_MINIMUM_NOTIONAL" || code === "EXPERIMENT_MARGIN_INSUFFICIENT")) {
        // B's margin failing is B's shortfall: it counts toward ending a pair that cannot follow.
        await this.sourceBelowMinimumExit(c, p, r, t, code === "EXPERIMENT_MARGIN_INSUFFICIENT"); return;
      }
      // Nothing was sent for this round. The connector already lifts a sized opening to the
      // market minimum, so a refusal here means even that minimum is out of reach (the
      // approved single-order cap is below it): the pair ends (no risk is open) instead of
      // retrying forever.
      if (role === "A_OPEN" && c.sizing && code === "EXPERIMENT_BELOW_MINIMUM_NOTIONAL" && !r.orders.some(o => o.state !== "ABORTED_UNSENT")) {
        await this.change(c.id, current => { if (!this.active(current, t)) return;
          const pair = current.groups.flatMap(g => g.pairs).find(pair => pair.id === p.id)!, round = pair.rounds.find(round => round.id === r.id)!;
          if (round.orders.some(o => o.state !== "ABORTED_UNSENT")) return;
          round.state = "COMPLETED"; round.completedAt = this.now(); pair.lastFlatAt = round.completedAt; pair.state = "COMPLETED"; pair.errorCode = "EXPERIMENT_CAPITAL_TOO_SMALL"; });
        return;
      }
      throw error;
    }
    if (!this.active(await this.get(c.id), t)) return;
    if (role === "A_OPEN" && (this.now() < r.openAt || this.now() >= windowEnd)) return;
    if (prepared.id !== request.id || prepared.mode !== c.mode || prepared.chainId !== c.chainId || prepared.owner !== request.owner || prepared.productId !== pairProductId(c, p) ||
      prepared.side !== request.side || prepared.postOnly !== request.postOnly || prepared.reduceOnly !== request.reduceOnly ||
      // B's taker close (A is already flat) may come back rounded down to whole size steps.
      (quantity !== undefined && prepared.quantityX18 !== quantity && !(role === "B_CLOSE" && !request.postOnly && /^[1-9]\d*$/.test(prepared.quantityX18) && BigInt(prepared.quantityX18) < BigInt(quantity))) ||
      !/^0x[0-9a-f]{64}$/.test(prepared.digest) || !prepared.payload || prepared.payload.length > 30000 || !Number.isSafeInteger(prepared.expiration)) refuse("EXPERIMENT_PREPARED_IDENTITY_MISMATCH");
    rawAmount(prepared.quantityX18, true); rawAmount(prepared.priceX18, true); rawAmount(prepared.nonce);
    if (prepared.minimumHedgeQuantityX18 !== undefined && rawAmount(prepared.minimumHedgeQuantityX18) > BigInt(prepared.quantityX18) && role === "A_OPEN") refuse("EXPERIMENT_SIZE_HEDGE_INFEASIBLE");
    const claimed = await this.change(c.id, current => {
      if (!this.active(current, t) || (winding(current, p) && !close)) return false;
      const round = current.groups.flatMap(g => g.pairs).find(pair => pair.id === p.id)!.rounds.find(round => round.id === r.id)!;
      const prior = orderFor(round, role);
      if (round.orders.some(o => o.id === prepared.id) || (prior && (!repeatable || prior.state !== "TERMINAL"))) return false;
      if (role === "A_OPEN" && round.orders.some(o => o.role === "A_OPEN" && BigInt(o.filledX18) > 0n)) return false;
      if (current.groups.some(g => g.pairs.some(p => p.rounds.some(r => r.orders.some(o => o.digest === prepared.digest))))) refuse("EXPERIMENT_DIGEST_REUSED");
      round.orders.push({ ...prepared, role, state: "PREPARED", epoch: current.epoch, createdAt: this.now(), factKnown: false, filledX18: "0", quoteFilledX18: "0", feePaidX18: "0" }); return true;
    });
    if (!claimed) return;
    const allowed = () => !this.halted && this.generation === t.generation && (role !== "A_OPEN" || (this.now() >= r.openAt && this.now() < windowEnd));
    const send = await this.change(c.id, current => {
      const o = current.groups.flatMap(g => g.pairs).flatMap(p => p.rounds).flatMap(r => r.orders).find(o => o.id === prepared.id)!;
      if (!this.active(current, t) || (winding(current, p) && !close)) { o.state = "ABORTED_UNSENT"; o.payload = ""; return false; }
      if (o.state !== "PREPARED") return false; o.state = "DISPATCHED"; return true;
    });
    if (!send) return;
    if (!allowed()) { await this.change(c.id, current => { const o = current.groups.flatMap(g => g.pairs).flatMap(p => p.rounds).flatMap(r => r.orders).find(o => o.id === prepared.id)!; o.state = "ABORTED_UNSENT"; o.payload = ""; }); return; }
    this.emit({ event: "order_send", level: "info", campaignId: c.id, pairId: p.id, round: r.number, data: { role, attempt, postOnly: prepared.postOnly, reduceOnly: prepared.reduceOnly, side: prepared.side, quantity: prepared.quantityX18, price: prepared.priceX18 } });
    try { if ((await this.connector.dispatch(c, prepared, allowed)).toLowerCase() !== prepared.digest) throw Error("ACK"); }
    catch (error) {
      const message = error instanceof Error ? error.message : "", refused = /^ORDER_REFUSED_(\d+)$/.exec(message);
      this.emit({ event: "order_not_confirmed", level: refused ? "info" : "warn", campaignId: c.id, pairId: p.id, round: r.number, data: { role, attempt, code: message.slice(0, 80) } });
      const find = (current: ExperimentCampaign) => current.groups.flatMap(g => g.pairs).flatMap(p => p.rounds).flatMap(r => r.orders).find(o => o.id === prepared.id)!;
      // A rate limit: the exchange never took it, so it is no attempt at all; back off a minute.
      // The local order gate refusing before any send (all trading stopped, another order
      // unresolved) likewise sent nothing: no phantom unknown order to look up.
      // A freshly opened account may still be in the exchange's address screening (2023).
      const unsent = error instanceof ExperimentUnsentOrderError ? experimentErrorCode(error)
        : refused && ["1000", "1015"].includes(refused[1]!) ? "EXPERIMENT_RATE_LIMITED"
        : refused?.[1] === "2023" ? "EXPERIMENT_ADDRESS_SCREENING"
        : (close && prepared.postOnly && message === "EXPERIMENT_CLOSE_POSITION_CHANGED") || (close && message === "EXPERIMENT_REDUCE_ONLY_REQUIRED") ? message
        : ["STOPPED", "TRADING_STOPPED", "UNRESOLVED_ORDER"].includes(message) ? message : undefined;
      if (unsent) {
        await this.change(c.id, current => { const o = find(current); if (o.state !== "TERMINAL") { o.state = "ABORTED_UNSENT"; o.payload = ""; o.errorCode = message; } });
        // A lock-held position recheck refused this exact maker before any submit:
        // re-read the real remainder (or close A if B is already flat), without an
        // artificial UNKNOWN request or a one-minute one-sided pause.
        if(unsent!=="EXPERIMENT_CLOSE_POSITION_CHANGED")await this.pause(c.id, p.id, unsent,t); return;
      }
      if(!this.active(await this.get(c.id),t))return;
      await this.change(c.id, current => { const o = find(current); if (o.state !== "TERMINAL") o.state = "UNKNOWN"; if (refused || /^ORDER_REJECTED_\d+$/.test(message)) o.errorCode = message; });
      // An explicit exchange refusal (never placed) is resolved by the original-request
      // lookup at once, so the round re-prices on the next tick instead of pausing.
      if (refused) {
        await this.poll(c, p, r, find(await this.get(c.id)),t);
        // A's opening refused three times in a row for margin/health is not price noise:
        // this round ends empty (nothing is open) and the pair pauses with that reason; the
        // next round counts afresh. Closes and B's follow never pause here: closes retry
        // until flat and B's follow has its own attempt limit and exit.
        // B's follow refused for its margin or health: B's margin is no longer read before
        // the follow (A's opening already checked it), so the exchange's refusal ends the
        // follow at once, as that read did: A's position is closed instead of retried.
        if (role === "B_OPEN" && ["2006", "2036", "2092"].includes(refused[1]!)) {
          const leg = (await this.get(c.id)).groups.flatMap(g => g.pairs).flatMap(p => p.rounds).find(x => x.id === r.id)!.orders.find(o => o.id === prepared.id);
          if (leg?.state === "TERMINAL") await this.sourceBelowMinimumExit(c, p, r, t, true);
          return;
        }
        if (role === "A_OPEN" && ["2006", "2036", "2092"].includes(refused[1]!)) {
          const legs = (await this.get(c.id)).groups.flatMap(g => g.pairs).flatMap(p => p.rounds).find(x => x.id === r.id)!.orders.filter(o => o.role === role && o.state !== "ABORTED_UNSENT").slice(-3);
          if (legs.length === 3 && legs.every(o => o.errorCode === message && o.state === "TERMINAL" && o.filledX18 === "0")) {
            await this.phase(c.id, p.id, r.id, "VERIFYING_FLAT", t);
            await this.pause(c.id, p.id, "EXPERIMENT_ORDER_REFUSED_REPEATEDLY",t);
          }
        }
        // A taker close refused three times in a row for being below the exchange's minimum
        // size would otherwise be re-sent forever: the pair pauses (the round and its
        // position stay as they are) and says why, so the remainder can be closed by hand.
        if ((role === "A_CLOSE" || role === "B_CLOSE") && !prepared.postOnly && ["2003", "2094"].includes(refused[1]!)) {
          const legs = (await this.get(c.id)).groups.flatMap(g => g.pairs).flatMap(p => p.rounds).find(x => x.id === r.id)!.orders.filter(o => o.role === role && !o.postOnly && o.state !== "ABORTED_UNSENT").slice(-3);
          if (legs.length === 3 && legs.every(o => o.errorCode === message && o.state === "TERMINAL" && o.filledX18 === "0"))
            await this.pause(c.id, p.id, "EXPERIMENT_CLOSE_BELOW_MINIMUM",t);
        }
        return;
      }
      // A malformed or mis-signed request stopped all trading: resolve it, then say why.
      if (/^ORDER_REJECTED_\d+$/.test(message)) { await this.poll(c, p, r, find(await this.get(c.id)),t); await this.pause(c.id, p.id, message,t); return; }
      await this.pause(c.id, p.id, "EXPERIMENT_DISPATCH_UNKNOWN",t);
    }
  }
  private async cancel(c: ExperimentCampaign, p: ExperimentPair, r: ExperimentRound, o: ExperimentOrder, t: Token): Promise<void> {
    if (!this.active(c, t)) return;
    if (o.cancelState) { await this.poll(c, p, r, o,t); return; }
    const claimed = await this.change(c.id, current => { if (!this.active(current, t)) return false;
      const row = current.groups.flatMap(g => g.pairs).flatMap(p => p.rounds).flatMap(r => r.orders).find(row => row.id === o.id)!;
      if (row.state === "TERMINAL" || row.cancelState) return false; row.cancelState = "DISPATCHED"; return true; });
    if (!claimed) return;
    const allowed = () => !this.halted && this.generation === t.generation;
    if (!allowed()) return;
    try {
      const fact = await this.connector.cancel(c, o, allowed);
      // Cancelled, but the part filled before it is not in the history yet: the cancel claim
      // stays and the next step looks the order up (see lagging).
      if (this.lagging(o, fact)) return;
      await this.applyFact(c.id, p.id, r.id, o.id, fact);
      if (fact.terminal) this.lookedAt.delete(o.id);
    }
    catch { if(!this.active(await this.get(c.id),t))return; this.lagSince.delete(o.id); await this.change(c.id, current => { const row = current.groups.flatMap(g => g.pairs).flatMap(p => p.rounds).flatMap(r => r.orders).find(row => row.id === o.id)!; if (this.active(current,t)&&row.state !== "TERMINAL") { row.cancelState = "UNKNOWN"; row.state = "UNKNOWN"; } }); await this.pause(c.id, p.id, "EXPERIMENT_CANCEL_UNKNOWN",t); }
  }
  /** Nothing to do but wait: for the opening time, or for the end of the hold. */
  private idle(c: ExperimentCampaign, r: ExperimentRound, p?: ExperimentPair): boolean {
    const now = this.now();
    return !winding(c, p) && ((r.state === "WAITING_OPEN" && now < r.openAt && now < openWindowEnd(r)) || (r.state === "HOLDING" && r.holdUntil !== undefined && now < r.holdUntil));
  }
  /** The pass may stop here: the round waits (to open, while holding, done) or its maker rests. */
  private settled(p: ExperimentPair): boolean {
    const r = last(p);
    return !r || ["WAITING_OPEN", "HOLDING", "COMPLETED"].includes(r.state) ||
      (["A_OPEN", "B_CLOSE_MAKER", "A_CLOSE"].includes(r.state) && r.orders.some(o => o.postOnly && o.state === "DISPATCHED" && !o.cancelState));
  }
  private print(p: ExperimentPair) {
    const r = last(p);
    return JSON.stringify([p.state, p.rounds.length, r?.id, r?.state, r?.orders.map(o => [o.id, o.state, o.filledX18, o.cancelState ?? ""])]);
  }
  /** One runner per pair: the timer pass and a wake-up never step the same pair at once; a
   *  wake-up that arrives meanwhile has the runner step the pair once more right after. */
  private async lane(c: ExperimentCampaign, p: ExperimentPair, t: Token, woken = false): Promise<void> {
    const key = this.key(c, p);
    if (this.lanes.has(key) || (woken && this.reconciling)) { if (woken) this.woken.add(key); return; }
    this.lanes.add(key);
    try {
      for (let pass = 0; pass < 3; pass++) {
        this.woken.delete(key);
        try {
          if (!this.active(await this.get(c.id), t)) return;
          await this.runPair(c, p, t, woken);
        } catch (e) { await this.pause(c.id, p.id, experimentErrorCode(e),t).catch(() => {}); return; }
        if (!this.woken.has(key)) return;
        const fresh = await this.get(c.id), q = pairById(fresh, p.id), r = q && last(q);
        if (!q || q.state !== "ACTIVE" || !r || r.state === "COMPLETED") return;
        c = fresh; p = q; woken = true;
      }
    } finally { this.lanes.delete(key); this.woken.delete(key); this.urgent(c, p, false); }
  }
  /**
   * A fill was seen on one of this pair's wallets (a hint, e.g. from the exchange's public
   * fill stream): the pair takes its next step now instead of at the next timer pass. Only a
   * pair in the middle of a round is stepped, and facts still come only from the exchange's
   * reads, so a wrong or late hint costs a read and changes nothing.
   */
  async nudge(id: string, pairId: string): Promise<void> {
    if (this.halted || this.reconciling) return;
    const c = (await this.query(id))[0];
    if (!c || !["RUNNING", "EXITING"].includes(c.state)) return;
    const p = pairById(c, pairId), r = p && last(p);
    if (!p || p.state !== "ACTIVE" || !r || r.state === "COMPLETED") return;
    await this.lane(c, p, { epoch: c.epoch, generation: this.generation }, true);
  }
  /**
   * Steps one pair. A step that leads straight to the next (see CHAIN_STEPS) continues at
   * once. Accounts are read when a step needs them: a read is reused within the pass for a
   * wallet whose orders did not change since (see VIEW_MAX_AGE_MS), and without loss or fee
   * limits a waiting pair reads only every IDLE_READ_MS. With limits every pass reads first,
   * as before, since they are checked on each read.
   */
  private async runPair(c: ExperimentCampaign, p: ExperimentPair, t: Token, woken = false): Promise<void> {
    const key = this.key(c, p), limited = c.maxLossPerWalletX18 !== undefined || c.maxFeePerWalletX18 !== undefined;
    const first = last(p);
    if (first && this.idle(c, first, p) && (woken || (!limited && this.elapsed(this.readAt.get(key)) < IDLE_READ_MS))) return;
    // A hedging pair's reads go first from the pass's first read on.
    if (woken || (first && (HOT_STATES.includes(first.state) || (winding(c, p) && first.state !== "COMPLETED")))) this.urgent(c, p, true);
    let view: View | undefined;
    const read = async (force = false): Promise<View> => {
      const before = await this.get(c.id), q = pairById(before, p.id) ?? p, r = last(q);
      const marks = { a: mark(r, q.a), b: mark(r, q.b) };
      const snap = await this.account(before, q);
      return { snap, at: snap.observedAt, round: r?.id, marks, recorded: await this.recordStats(before, q, snap, force) };
    };
    // `record`: this read's statistics are written even if a recent read was (the flat proof).
    const need = async (who: "a" | "b" | "ab", record = false): Promise<ExperimentPairSnapshot> => {
      const fresh = await this.get(c.id), q = pairById(fresh, p.id) ?? p, r = last(q);
      const ok = (w: "a" | "b") => view !== undefined && view.round === r?.id && view.marks[w] === mark(r, w === "a" ? q.a : q.b) && this.now() >= view.at && this.now() - view.at < VIEW_MAX_AGE_MS;
      if (!(who === "ab" ? ok("a") && ok("b") : ok(who))) view = await read(record);
      else if (record && !view!.recorded) view!.recorded = await this.recordStats(fresh, q, view!.snap, true);
      return view!.snap;
    };
    if (limited || this.elapsed(this.readAt.get(key)) >= IDLE_READ_MS) view = await read();
    const sent = (q: ExperimentPair) => last(q)?.orders.filter(o => o.state !== "ABORTED_UNSENT").length ?? 0;
    let round = first?.id, orders = first ? sent(p) : 0;
    const started = this.now();
    for (let n = 0; n < (this.chain ? CHAIN_STEPS : 1); n++) {
      c = await this.get(c.id);
      // Limits opt into a fresh account/statistics read for EVERY chained transition,
      // not just the timer pass. A fill can spend the fee budget between two steps.
      if (limited && n > 0 && this.active(c, t)) { view = await read(); c = await this.get(c.id); }
      const q = pairById(c, p.id);
      if (!q || !this.active(c, t)) return;
      p = q;
      const r = last(p), before = this.print(p);
      if (r?.id !== round) { round = r?.id; orders = sent(p); }
      if (r && (HOT_STATES.includes(r.state) || (winding(c, p) && r.state !== "COMPLETED"))) this.urgent(c, p, true);
      await this.stepPair(c, p, t, need, woken);
      const after = await this.get(c.id), fresh = pairById(after, p.id);
      if (!fresh || !this.active(after, t) || fresh.state !== "ACTIVE" || this.print(fresh) === before || this.settled(fresh)) return;
      if ((last(fresh)?.id === round && sent(fresh) - orders >= PASS_ORDERS) || this.now() - started >= PASS_MS) return;
    }
  }
  /** A resting maker that needs no read this pass: its fills are pushed (no wake-up means no
   *  fill), its wallet was read within RESTING_READ_MS and its order looked up recently. */
  private quiet(c: ExperimentCampaign, p: ExperimentPair, o: ExperimentOrder, woken: boolean): boolean {
    const pushed = this.hint(() => this.connector.fillHints?.(c));
    return pushed && !woken && this.elapsed(this.readAt.get(this.key(c, p))) < RESTING_READ_MS &&
      this.elapsed(this.lookedAt.get(o.id) ?? o.createdAt) < MAKER_LOOKUP_MS;
  }
  private async stepPair(c: ExperimentCampaign, p: ExperimentPair, t: Token, need: (who: "a" | "b" | "ab", record?: boolean) => Promise<ExperimentPairSnapshot>, woken = false): Promise<void> {
    let r = last(p);
    if (!r || r.state === "COMPLETED") {
      const snapshot = await need("ab");
      if (signed(snapshot.a.positionX18) !== 0n || signed(snapshot.b.positionX18) !== 0n || snapshot.a.openDigests.length || snapshot.b.openDigests.length) refuse("EXPERIMENT_NOT_FLAT");
      const done = c.exitRequested || [p.a, p.b].every(a => BigInt(c.wallets[a]!.quoteFilledX18) >= BigInt(c.targetNotionalPerWalletX18));
      // A wallet that received (almost) nothing cannot trade at all: the pair ends here
      // with its reason instead of blocking the group, and the report shows the shortfall.
      const exhausted = !done && !!c.sizing && [p.a, p.b].some(a => { const k = c.wallets[a]!.baselineEquityX18; return k !== undefined && BigInt(k) < CAPITAL_FLOOR_X18; });
      // B failed to follow three rounds in a row (each costing A a round trip): this pair's
      // size no longer works in this market, so it ends with its reason instead of burning fees.
      const recent = p.rounds.slice(-3);
      const unfollowable = !done && recent.length === 3 && recent.every(x => x.earlyExitReason === "FOLLOWER_INCOMPLETE_EXIT");
      // A's opening refused for margin in three rounds in a row (each round ends with no
      // trade): this pair's size does not fit its margin; it ends instead of cycling forever.
      const unfundable = !done && recent.length === 3 && recent.every(x => x.orders.length > 0 && x.orders.every(o => o.role === "A_OPEN" && o.filledX18 === "0" && /^ORDER_REFUSED_(2006|2036|2092)$/.test(o.errorCode ?? "")));
      await this.change(c.id, current => { if (!this.active(current, t)) return; const pair = pairById(current, p.id)!;
        pair.lastFlatAt = this.now();
        // Pause-and-flatten: this pair is flat; it starts nothing new until resumed.
        if (current.flattenRequested && !done) return;
        if (done) pair.state = "COMPLETED";
        // Wound down and flat: ends early; its money moves on with the group as usual.
        else if (pair.closeOnlyAt !== undefined) { pair.state = "COMPLETED"; pair.errorCode = "EXPERIMENT_PAIR_CLOSED_EARLY"; }
        else if (exhausted) { pair.state = "COMPLETED"; pair.errorCode = "EXPERIMENT_CAPITAL_TOO_SMALL"; }
        else if (unfollowable) { pair.state = "COMPLETED"; pair.errorCode = "EXPERIMENT_FOLLOW_REPEATEDLY_FAILED"; }
        else if (unfundable) { pair.state = "COMPLETED"; pair.errorCode = "EXPERIMENT_MARGIN_REPEATEDLY_REFUSED"; }
        else { pair.state = "ACTIVE"; pair.rounds.push(this.makeRound(current, pair)); } }); return;
    }
    if (winding(c, p) && !["A_CLOSE", "CANCEL_A_CLOSE", "B_CLOSE", "VERIFYING_FLAT"].includes(r.state)) {
      const source = orderFor(r, "A_OPEN");
      const unresolved = r.orders.filter(o => o.state === "UNKNOWN" || o.cancelState === "UNKNOWN");
      if (unresolved.length) { for (const o of unresolved) await this.poll(c, p, r, o,t); return; }
      if (source && source.state !== "TERMINAL") { await this.phase(c.id, p.id, r.id, "CANCEL_A_OPEN", t); await this.cancel(c, p, r, source, t); return; }
      // B's resting maker close is withdrawn too; everything then closes by taker.
      const resting = r.orders.find(o => o.role === "B_CLOSE" && o.postOnly && o.state === "DISPATCHED");
      if (resting) { await this.cancel(c, p, r, resting, t); return; }
      if (r.orders.some(o => o.state === "DISPATCHED" && !o.postOnly)) { for (const o of r.orders.filter(o => o.state === "DISPATCHED")) await this.poll(c, p, r, o,t); return; }
      await this.change(c.id, current => { if (!this.active(current, t)) return;
        const round = pairById(current, p.id)!.rounds.find(round => round.id === r!.id)!;
        if (current.flattenRequested && !round.earlyExitReason && round.orders.some(o => BigInt(o.filledX18) > 0n)) round.earlyExitReason = "PAUSE_FLATTEN_EXIT";
        round.state = "A_CLOSE"; });
      return;
    }
    if (!c.costGate && this.connector.marketCost) {
      // Shadow gate only: keeps this market's price samples alive between openings (the sampler
      // drops a market idle for 2 minutes), so the verdict at the next opening has a series.
      const pid = pairProductId(c, p), key = `${c.id}:${pid}`;
      if (this.now() - (this.shadowWatchAt.get(key) ?? -Infinity) >= 60_000) {
        this.shadowWatchAt.set(key, this.now()); void this.connector.marketCost(c, pid).catch(() => {});
        if (this.shadowWatchAt.size > 200) for (const [k, at] of this.shadowWatchAt) if (this.now() - at > 600_000) this.shadowWatchAt.delete(k);
      }
    }
    switch (r.state) {
      case "WAITING_OPEN":
        if (this.now() >= openWindowEnd(r)) {
          await this.change(c.id, current => { if (!this.active(current, t)) return;
            const round = pairById(current, p.id)!.rounds.find(round => round.id === r!.id)!;
            // A missed window gets a fresh offset. Reusing a late offset can
            // repeatedly miss the same polling phase and starve this pair.
            const time = slotTiming(round.slotMs);
            round.openAt = Math.ceil(this.now() / time.slotMs) * time.slotMs + Math.floor(this.draw() * time.openOffsetMs); }); return;
        }
        if (this.now() >= r.openAt) {
          // Low-cost opening: wait (within this and later slots) for a calm market, at most
          // the plan's wait; facts that cannot be read are never taken as calm.
          if (c.costGate && this.connector.marketCost) {
            const since = r.costWaitSince ?? this.now();
            let fact; try { fact = await this.connector.marketCost(c, pairProductId(c, p)); } catch { fact = undefined; }
            const d = costGateDecision(c.costGate, fact, this.now() - since);
            // A round that waited opens only early in a slot (time for its maker and B's
            // follow before the slot ends) and at its own second of the minute, so pairs
            // released together by a calm moment (or a shared limit) do not all send at once.
            const time = slotTiming(r.slotMs), slot = slotStart(this.now(), r.slotMs);
            const spread = r.costWaitSince === undefined || (this.now() - slot < time.gatedOpenByMs && (((this.now() - r.openAt) % time.openOffsetMs) + time.openOffsetMs) % time.openOffsetMs < time.gatedReleaseMs);
            if (d.open && !spread) return;
            if (!d.open) {
              if (r.costWaitSince === undefined || r.costWaitCode !== d.code) await this.change(c.id, current => { if (!this.active(current, t)) return;
                const round = pairById(current, p.id)!.rounds.find(round => round.id === r!.id)!;
                if (round.state !== "WAITING_OPEN") return;
                round.costWaitSince ??= since; round.costWaitCode = d.code; });
              return;
            }
            // The wait ends: its time is kept on the round (for the cost statistics).
            if (r.costWaitSince !== undefined) await this.change(c.id, current => { if (!this.active(current, t)) return;
              const round = pairById(current, p.id)!.rounds.find(round => round.id === r!.id)!;
              if (round.costWaitSince === undefined) return;
              round.costWaitMs = (round.costWaitMs ?? 0) + Math.max(0, this.now() - round.costWaitSince);
              round.costWaitSince = undefined; round.costWaitCode = undefined; });
            if (d.timedOut) this.emit({ event: "cost_gate_timeout", level: "info", campaignId: c.id, pairId: p.id, round: r.number, data: { code: d.code, waitedMs: this.now() - since } });
          }
          // Never awaited: the opening does not wait for this statistic (independent review).
          if (!c.costGate && this.connector.marketCost && !this.gateShadow.has(r.id)) {
            const id = r.id; this.gateShadow.set(id, "PENDING");
            void this.connector.marketCost(c, pairProductId(c, p)).then(fact => {
              const d = costGateDecision({ maxSpreadTicks: 2, relative: true, maxWaitMs: Number.MAX_SAFE_INTEGER }, fact, 0);
              if (this.gateShadow.get(id) === "PENDING") this.gateShadow.set(id, d.open ? "CALM" : d.code ?? "UNKNOWN"); },
            () => { if (this.gateShadow.get(id) === "PENDING") this.gateShadow.set(id, "COST_GATE_UNREADABLE"); });
          }
          // Both wallets are read flat right before the opening (not while it waits).
          const snapshot = await need("ab");
          if (snapshot.a.openDigests.length || snapshot.b.openDigests.length || signed(snapshot.a.positionX18) || signed(snapshot.b.positionX18)) refuse("EXPERIMENT_NOT_FLAT");
          await this.phase(c.id, p.id, r.id, "A_OPEN", t);
          // Do not require a second timer tick inside the same first minute.
          // place() still rechecks the window and stop permit before sending.
          await this.place(c, p, r, "A_OPEN", undefined, t);
        }
        return;
      case "A_OPEN": {
        const o = orderFor(r, "A_OPEN");
        // No attempt yet, or the last attempt ended with no fill: (re-)post while the window is open.
        if (!o || (o.state === "TERMINAL" && o.factKnown && BigInt(o.filledX18) === 0n)) {
          if (o && this.now() >= openWindowEnd(r)) { await this.phase(c.id, p.id, r.id, "VERIFYING_FLAT", t); return; }
          if (this.now() >= openWindowEnd(r)) { await this.phase(c.id, p.id, r.id, "WAITING_OPEN", t); return; }
          const snapshot = await need("ab");
          if (snapshot.a.openDigests.length || snapshot.b.openDigests.length || signed(snapshot.a.positionX18) || signed(snapshot.b.positionX18)) refuse("EXPERIMENT_NOT_FLAT"); await this.place(c, p, r, "A_OPEN", undefined, t); return; }
        // Live positions: A started flat, so its position is what its maker has filled. While
        // that matches what is known, nothing filled since and the maker needs no lookup
        // (it is still looked up every MAKER_LOOKUP_MS); a change is a fill to follow now.
        if (o.state === "DISPATCHED" && !o.cancelState && this.hint(() => this.connector.livePositions?.(c))) {
          if (this.quiet(c, p, o, woken)) { if (await this.makerDue(c, o)) await this.phase(c.id, p.id, r.id, "CANCEL_A_OPEN", t); return; }
          const moved = abs(signed((await need("a")).a.positionX18)) !== BigInt(o.filledX18);
          if (!moved && this.elapsed(this.lookedAt.get(o.id) ?? o.createdAt) < MAKER_LOOKUP_MS) {
            if (await this.makerDue(c, o)) await this.phase(c.id, p.id, r.id, "CANCEL_A_OPEN", t);
            return;
          }
          if (moved) this.urgent(c, p, true);
        }
        const fact = await this.poll(c, p, r, o,t); if (!fact) return;
        if (fact.state === "TERMINAL") await this.advanceFinalSource(c, p, r, fact, t);
        else if (BigInt(fact.filledX18) >= this.minimumHedge(fact) || await this.makerDue(c, fact)) await this.phase(c.id, p.id, r.id, "CANCEL_A_OPEN", t);
        return;
      }
      case "CANCEL_A_OPEN": {
        const o = orderFor(r, "A_OPEN"); if (!o) refuse("EXPERIMENT_ORDER_MISSING");
        if (o.state !== "TERMINAL") { await this.cancel(c, p, r, o, t); return; }
        await this.advanceFinalSource(c, p, r, o, t); return;
      }
      case "B_OPEN": {
        const a = orderFor(r, "A_OPEN"); if (!a || a.state !== "TERMINAL" || !a.factKnown) refuse("EXPERIMENT_SOURCE_NOT_FINAL");
        // B follows A's actual base quantity. A partial or missed IOC (price moved past the
        // slippage bound, thin book) is followed again for the exact remainder at a fresh
        // price; after FOLLOW_ATTEMPTS the round closes both real positions instead of
        // waiting for the operator. Only confirmed fills ever count.
        const legs = r.orders.filter(o => o.role === "B_OPEN" && o.state !== "ABORTED_UNSENT");
        const open = legs.find(o => o.state !== "TERMINAL");
        if (open) { const fact = await this.poll(c, p, r, open,t); if (!fact || fact.state !== "TERMINAL") return; }
        const fresh = pairById(await this.get(c.id), p.id)!.rounds.find(round => round.id === r!.id)!;
        const followed = fresh.orders.filter(o => o.role === "B_OPEN" && o.state === "TERMINAL").reduce((n, o) => n + BigInt(o.filledX18), 0n), target = BigInt(a.filledX18);
        if (followed > target) refuse("EXPERIMENT_FOLLOW_OVERFILLED");
        if (followed === target) {
          await this.change(c.id, current => { if (!this.active(current, t)) return; const round = pairById(current, p.id)!.rounds.find(round => round.id === r!.id)!;
            const pairedAt = this.now(); round.state = "HOLDING"; round.pairedAt = pairedAt; round.holdUntil = pairedAt + round.holdMs; }); return;
        }
        const late = this.now() >= followDeadline(r);
        if (!late && fresh.orders.filter(o => o.role === "B_OPEN" && o.state !== "ABORTED_UNSENT").length < FOLLOW_ATTEMPTS && !winding(c, p)) {
          await this.place(c, p, fresh, "B_OPEN", String(target - followed), t); return;
        }
        await this.change(c.id, current => { if (!this.active(current, t)) return; const round = pairById(current, p.id)!.rounds.find(round => round.id === r!.id)!;
          round.earlyExitReason = late ? "FOLLOW_TIMEOUT_EXIT" : "FOLLOWER_INCOMPLETE_EXIT"; round.state = "A_CLOSE"; }); return;
      }
      case "HOLDING":
        // A normal round closes like it opened, mirrored: B makes, A takes.
        if (r.holdUntil !== undefined && this.now() >= r.holdUntil)
          await this.phase(c.id, p.id, r.id, c.closeMaker === "B" && !r.earlyExitReason && !this.noMakerClose.has(`${c.mode}:${c.chainId}:${pairProductId(c, p)}`) ? "B_CLOSE_MAKER" : "A_CLOSE", t);
        return;
      case "B_CLOSE_MAKER": {
        // B's position is closed by a post-only order kept at the best price; once B is
        // flat (or the maker time is up) A closes by taker, then any B remainder by taker.
        const o = [...r.orders].reverse().find(x => x.role === "B_CLOSE" && x.postOnly && x.state !== "ABORTED_UNSENT");
        const deadline = (r.holdUntil ?? this.now()) + slotTiming(r.slotMs).closeMakerMs;
        if (!o || o.state === "TERMINAL") {
          // A maker close the exchange refused for its size cannot be re-posted: close by taker.
          // (also a market in reduce-only mode, which refuses this non-reduce-only order).
          const sizeRefused = /^ORDER_REFUSED_(2003|2067|2094|2119)$/.test(o?.errorCode ?? "");
          const market = `${c.mode}:${c.chainId}:${pairProductId(c, p)}`;
          if (o?.errorCode === "ORDER_REFUSED_2067" && o.factKnown && o.filledX18==="0" && o.postOnly && o.reduceOnly && !this.noMakerClose.has(market)) {
            this.noMakerClose.add(market);
            this.emit({ event: "maker_close_refused", level: "warn", campaignId: c.id, pairId: p.id, round: r.number, data: { code: o.errorCode } });
          }
          // Filled in full (it was B's whole position) or out of time: A closes at once; B's
          // own position is read again before any taker close of a remainder.
          const filled = o !== undefined && o.factKnown && BigInt(o.quantityX18) > 0n && BigInt(o.filledX18) === BigInt(o.quantityX18);
          if (filled || sizeRefused || this.now() >= deadline) { await this.phase(c.id, p.id, r.id, "A_CLOSE", t); return; }
          const snapshot = await need("b"), qty = abs(signed(snapshot.b.positionX18));
          if (!qty) { await this.phase(c.id, p.id, r.id, "A_CLOSE", t); return; }
          if ((r.side === "BUY") !== (signed(snapshot.b.positionX18) < 0n)) refuse("EXPERIMENT_POSITION_DIRECTION_CHANGED");
          await this.place(c, p, r, "B_CLOSE", String(qty), t, false, true); return;
        }
        // Live positions: B's position left is what its maker has not filled yet.
        if (o.state === "DISPATCHED" && !o.cancelState && this.hint(() => this.connector.livePositions?.(c))) {
          if (this.quiet(c, p, o, woken)) { if (this.now() >= deadline || await this.makerDue(c, o)) await this.phase(c.id, p.id, r.id, "CANCEL_B_CLOSE_MAKER", t); return; }
          const moved = abs(signed((await need("b")).b.positionX18)) !== BigInt(o.quantityX18) - BigInt(o.filledX18);
          if (!moved && this.elapsed(this.lookedAt.get(o.id) ?? o.createdAt) < MAKER_LOOKUP_MS) {
            if (this.now() >= deadline || await this.makerDue(c, o)) await this.phase(c.id, p.id, r.id, "CANCEL_B_CLOSE_MAKER", t);
            return;
          }
          if (moved) this.urgent(c, p, true);
        }
        const fact = await this.poll(c, p, r, o,t); if (!fact || fact.state === "TERMINAL") return;
        if(!fact.reduceOnly){await this.phase(c.id,p.id,r.id,"CANCEL_B_CLOSE_MAKER",t);return;}
        // If a known remaining maker no longer fits B's observed position, withdraw
        // it before it can flip B. A normal partial fill explains the smaller position
        // and keeps the approved maker wait; unknown fills still require original lookup.
        const position=signed((await need("b")).b.positionX18),remaining=BigInt(fact.quantityX18)-BigInt(fact.filledX18);
        if(remaining>0n&&(position===0n||abs(position)<remaining||(r.side==="BUY")!==(position<0n))) {
          await this.phase(c.id,p.id,r.id,"CANCEL_B_CLOSE_MAKER",t);return;
        }
        if (BigInt(fact.filledX18) === BigInt(fact.quantityX18) || this.now() >= deadline || await this.makerDue(c, fact)) await this.phase(c.id, p.id, r.id, "CANCEL_B_CLOSE_MAKER", t);
        return;
      }
      case "CANCEL_B_CLOSE_MAKER": {
        const o = [...r.orders].reverse().find(x => x.role === "B_CLOSE" && x.postOnly && x.state !== "ABORTED_UNSENT"); if (!o) refuse("EXPERIMENT_ORDER_MISSING");
        if (o.state !== "TERMINAL") { await this.cancel(c, p, r, o, t); return; }
        await this.phase(c.id, p.id, r.id, "B_CLOSE_MAKER", t); return;
      }
      case "A_CLOSE": {
        const o = orderFor(r, "A_CLOSE");
        if (!o || o.state === "TERMINAL") { const snapshot = await need("a"), qty = abs(signed(snapshot.a.positionX18)); if (!qty) { if (snapshot.a.openDigests.length) refuse("EXPERIMENT_A_ORDERS_REMAIN"); await this.phase(c.id, p.id, r.id, "B_CLOSE", t); return; }
          if ((r.side === "BUY") !== (signed(snapshot.a.positionX18) > 0n)) refuse("EXPERIMENT_POSITION_DIRECTION_CHANGED");
          await this.place(c, p, r, "A_CLOSE", String(qty), t, !!o || c.closeMaker === "B"); return; }
        const fact = await this.poll(c, p, r, o,t); if (!fact) return;
        if (fact.state === "TERMINAL") return; // Next tick obtains fresh remaining position before any next attempt.
        // A partly filled taker close becomes final within seconds (see ExperimentConnector.lookup).
        if (!fact.postOnly) { if (this.closeNonfinalExpired(c,fact)) await this.pause(c.id, p.id, "EXPERIMENT_CLOSE_NONFINAL",t); return; }
        if (BigInt(fact.filledX18) || this.now() - fact.createdAt >= (c.makerTimeoutMs ?? 30000)) await this.phase(c.id, p.id, r.id, "CANCEL_A_CLOSE", t);
        return;
      }
      case "CANCEL_A_CLOSE": {
        const o = orderFor(r, "A_CLOSE"); if (!o) refuse("EXPERIMENT_ORDER_MISSING");
        if (o.state !== "TERMINAL") { await this.cancel(c, p, r, o, t); return; }
        await this.phase(c.id, p.id, r.id, "A_CLOSE", t); return;
      }
      case "B_CLOSE": {
        const snapshot = await need("ab");
        if (signed(snapshot.a.positionX18) !== 0n || snapshot.a.openDigests.length) refuse("EXPERIMENT_A_NOT_FLAT");
        const qty = abs(signed(snapshot.b.positionX18)), o = orderFor(r, "B_CLOSE");
        if (!o || o.state === "TERMINAL") { if (!qty) { if (snapshot.b.openDigests.length) refuse("EXPERIMENT_B_ORDERS_REMAIN"); await this.phase(c.id, p.id, r.id, "VERIFYING_FLAT", t); return; }
          if ((r.side === "BUY") !== (signed(snapshot.b.positionX18) < 0n)) refuse("EXPERIMENT_POSITION_DIRECTION_CHANGED");
          await this.place(c, p, r, "B_CLOSE", String(qty), t); return; }
        const fact = await this.poll(c, p, r, o,t); if (!fact) return;
        if (fact.state !== "TERMINAL" && this.closeNonfinalExpired(c,fact)) { await this.pause(c.id, p.id, "EXPERIMENT_CLOSE_NONFINAL",t); return; }
        return;
      }
      case "VERIFYING_FLAT": {
        // The flat proof's read is also the round's final result: always written.
        const snapshot = await need("ab", true);
        if (signed(snapshot.a.positionX18) || signed(snapshot.b.positionX18) || snapshot.a.openDigests.length || snapshot.b.openDigests.length || r.orders.some(o => !["TERMINAL", "ABORTED_UNSENT"].includes(o.state))) refuse("EXPERIMENT_NOT_FLAT");
        // Flat remote accounts are not proof that unrecorded liquidation/manual/ADL
        // closes earned the quote cashflows of this round. Do not fabricate PnL,
        // cost statistics, a successful sample or a rollover from missing fills.
        if(r.orders.some(o=>o.state!=="ABORTED_UNSENT"&&!o.factKnown)||[p.a,p.b].some(a=>r!.orders.filter(o=>o.owner===a).reduce((n,o)=>n+(o.side==="BUY"?1n:-1n)*BigInt(o.filledX18),0n)!==0n))refuse("EXPERIMENT_UNRECORDED_POSITION_CHANGE");
        await this.change(c.id, current => { if (!this.active(current, t)) return; const pair = pairById(current, p.id)!, round = pair.rounds.find(round => round.id === r!.id)!;
          round.state = "COMPLETED"; round.completedAt = this.now(); pair.lastFlatAt = round.completedAt;
          if (round.orders.every(o => o.state === "ABORTED_UNSENT" || (o.state === "TERMINAL" && o.factKnown))) {
            const pnl = (a: string) => round.orders.filter(o => o.owner === a && o.state === "TERMINAL")
              .reduce((n, o) => n + (o.side === "SELL" ? 1n : -1n) * BigInt(o.quoteFilledX18) - BigInt(o.feePaidX18), 0n);
            const traded = round.orders.some(o => BigInt(o.filledX18) > 0n);
            // What this round cost (fees by maker/taker, price per leg), kept when archived.
            // Statistics only: whatever happens here never keeps a round from completing.
            try { const cost = roundCost(round); if (cost) current.costs = addRoundCost(current.costs, cost, round.costWaitMs); }
            catch { /* the round completes; this round is missing from the cost totals */ }
            if (traded) {
              round.result = { aPnlX18: String(pnl(pair.a)), bPnlX18: String(pnl(pair.b)) };
              for (const [a, v] of [[pair.a, pnl(pair.a)], [pair.b, pnl(pair.b)]] as const) {
                const stat = current.wallets[a]!;
                stat.realizedPnlX18 = String(BigInt(stat.realizedPnlX18 ?? "0") + v);
                stat.roundsCounted = (stat.roundsCounted ?? 0) + 1;
                if (v > 0n) stat.roundsWon = (stat.roundsWon ?? 0) + 1; else if (v < 0n) stat.roundsLost = (stat.roundsLost ?? 0) + 1;
              }
            }
          }
          // A round that ends flat clears the pair's pause history.
          pair.retryCount = undefined; pair.errorCode = undefined; pair.lonelySince = undefined;
          round.flatProof = { observedAt: snapshot.observedAt, aPositionX18: "0", bPositionX18: "0", aOpenOrderCount: 0, bOpenOrderCount: 0 };
          this.emit({ event: "round_completed", level: "info", campaignId: current.id, pairId: pair.id, round: round.number,
            data: { early: round.earlyExitReason, aPnl: round.result?.aPnlX18, bPnl: round.result?.bPnlX18, orders: round.orders.length,
              // Statistics only (wear analysis); never keeps a round from completing.
              ...(() => { try { return roundCostFacts(round) ?? {}; } catch { return {}; } })(),
              ...(this.gateShadow.has(round.id) ? { gateShadow: this.gateShadow.get(round.id) } : {}) } });
          this.gateShadow.delete(round.id);
          // Rounds that never complete leave an entry: keep the map small (statistics only).
          if (this.gateShadow.size > 1000) for (const k of [...this.gateShadow.keys()].slice(0, 500)) this.gateShadow.delete(k); }); return;
      }
    }
  }
  private async rollFact(id: string, stepId: string, fact: ExperimentRolloverFact) {
    this.emit({ event: "rollover_fact", level: fact.state === "UNKNOWN" ? "warn" : "info", campaignId: id, data: { step: stepId.split(":").pop(), state: fact.state } });
    if (fact.id !== stepId || !fact.identityMatches || !["PENDING", "UNKNOWN", "CREDITED"].includes(fact.state)) refuse("EXPERIMENT_ROLLOVER_FACT_UNKNOWN");
    await this.change(id, c => { const step = c.rollovers.find(step => step.id === stepId); if (!step) refuse("EXPERIMENT_ROLLOVER_MISSING");
      if (step.state === "CREDITED" && fact.state !== "CREDITED") refuse("EXPERIMENT_ROLLOVER_REGRESSED");
      // A lookup never turns a step that was not yet claimed into a sent one.
      step.state = fact.state === "PENDING" ? (step.state === "PREPARED" ? "PREPARED" : "DISPATCHED") : fact.state; step.reference = fact.reference;
      // Shown on the group while it lasts; a stable code only, cleared by the next fact.
      step.errorCode = fact.state === "PENDING" && fact.waitingCode && /^[A-Z][A-Z0-9_]{0,63}$/.test(fact.waitingCode) ? fact.waitingCode : undefined;
      // Query-only from here on; the group step retries the lookup every minute.
      // Pair rolling: an unknown answer holds only this pair's chain (the step is looked up
      // again by itself, see finishPairs); the task and every other pair go on.
      if (fact.state === "UNKNOWN" && isPairRolling(c)) step.errorCode = "EXPERIMENT_ROLLOVER_UNKNOWN";
      else if (fact.state === "UNKNOWN") { c.errorCode = "EXPERIMENT_ROLLOVER_UNKNOWN"; if (["RUNNING", "EXITING", "ROLLING"].includes(c.state)) c.retryAt = this.now() + ROLLOVER_RETRY_MS; }
      else if (fact.state === "CREDITED" && c.errorCode === "EXPERIMENT_ROLLOVER_UNKNOWN") { c.errorCode = undefined; c.retryAt = undefined; c.retryCount = undefined; }
    });
  }
  private async finishGroup(c: ExperimentCampaign, t: Token) {
    const group = c.groups[c.activeGroup]!;
    if (!group.pairs.every(p => p.state === "COMPLETED")) return;
    // A pair set aside keeps its wallets as they are (they are not moved, see route shards).
    // Every pair's flat proof is read over FINISH_LANES lanes (reads and statistics writes only;
    // the store serialises the writes). The group moves on only if all of them came back flat.
    const queue = group.pairs.filter(p => p.setAsideAt === undefined), force = !c.rollovers.some(step => step.fromGroupId === group.id);
    const proofs = await Promise.allSettled(Array.from({ length: Math.min(FINISH_LANES, queue.length) }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const fact = await this.snapshot(c, p, force, true);
        if (signed(fact.a.positionX18) || signed(fact.b.positionX18) || fact.a.openDigests.length || fact.b.openDigests.length) refuse("EXPERIMENT_ROLLOVER_NOT_FLAT");
      }
    }));
    const failed = proofs.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    c = await this.get(c.id); if (!this.active(c, t) || c.flattenRequested) return;
    if (c.exitRequested) {
      // An exit never starts new money movement, but a group step already under way is
      // carried to its end (its rows may wait, e.g. for profit to settle), so the task
      // can finish instead of waiting forever.
      // A step still PREPARED was never handed to the connector (the DISPATCHED claim
      // comes first): nothing was sent, so on exit it is simply dropped.
      await this.change(c.id, current => { if (this.active(current, t)) current.rollovers = current.rollovers.filter(s => s.state !== "PREPARED"); });
      c = await this.get(c.id);
      if (!this.active(c, t)) return;
      for (const step of c.rollovers.filter(step => step.state !== "CREDITED")) {
        const before = step.state;
        const fact = await this.connector.lookupRollover(c, step);
        // Claimed but stopped before anything was created or sent: also dropped on exit.
        if (fact.notStarted && fact.id === step.id && fact.identityMatches) {
          await this.change(c.id, current => { if (this.active(current, t)) current.rollovers = current.rollovers.filter(s => s.id !== step.id); });
          continue;
        }
        await this.rollFact(c.id, step.id, fact);
        const fresh = await this.get(c.id), current = fresh.rollovers.find(s => s.id === step.id)!;
        if (before === "DISPATCHED" && current.state === "DISPATCHED" && fact.state === "PENDING" && this.active(fresh, t)) {
          // An exit starts no new money movement: rows of this step never sent (e.g. a Stop
          // came first) are released, not sent now; their money stays in the sending wallets
          // and the final collection takes it. Sending them here was refused anyway (the
          // task's own transfer is only admitted while it rolls), which kept the exit from
          // ever finishing.
          if (this.connector.abandonUnsentRollover) await this.rollFact(c.id, step.id, await this.connector.abandonUnsentRollover(fresh, current));
          else {
            const allowed = () => !this.halted && this.generation === t.generation;
            await this.rollFact(c.id, step.id, await this.connector.rollover(fresh, current, allowed));
          }
        }
      }
      c = await this.get(c.id);
      if (c.rollovers.some(step => step.state !== "CREDITED")) return;
    }
    const last = c.activeGroup === c.groups.length - 1;
    // 1.4.0 catch-up pass (operator choice): before the task ends, every pair set aside in an
    // earlier group gets one more go. The task goes back to the earliest such group; groups
    // whose transfer is already credited are passed again without moving any money; a pair
    // that recovered trades the rest of its target with rounds up to twice the usual size
    // (within the confirmed single-order cap); one that still fails winds down as before
    // (at most about 10 minutes). Its money is collected to F at the end.
    if (last && !c.exitRequested && c.catchUpPassAt === undefined && c.groups.some(g => g.pairs.some(p => p.setAsideAt !== undefined))) {
      const now = this.now();
      await this.change(c.id, current => { if (!this.active(current, t) || current.catchUpPassAt !== undefined) return;
        current.catchUpPassAt = now;
        let first = current.activeGroup;
        current.groups.forEach((g, i) => { for (const p of g.pairs) if (p.setAsideAt !== undefined) {
          first = Math.min(first, i);
          p.state = "PAUSED"; p.retryAt = now; p.retryCount = undefined; p.errorCode = undefined; p.catchUp = true;
          p.setAsideAt = undefined; p.setAsideCode = undefined; p.closeOnlyAt = undefined; p.closeOnlyCode = undefined; p.lonelySince = undefined;
        } });
        current.activeGroup = first; current.state = "RUNNING";
        this.emit({ event: "catch_up_pass", level: "info", campaignId: current.id, data: { group: first } });
      });
      return;
    }
    // A routed campaign returns its last group to the funding account before it can
    // complete. An exit request never starts new money movement.
    if (c.exitRequested || (last && !c.route)) { await this.change(c.id, current => { if (this.active(current, t)) { current.groups[current.activeGroup]!.completedAt = this.now(); current.state = "COMPLETED"; } }); return; }
    if (!last && !c.autoRoll) refuse("EXPERIMENT_ROLLOVER_DISABLED");
    const toGroupId = last ? FUNDING_ROUTE_TARGET : c.groups[c.activeGroup + 1]!.id, stableId = `experiment:${c.id}:roll:${c.activeGroup}`;
    await this.change(c.id, current => { if (!this.active(current, t) || current.flattenRequested || current.exitRequested) return; current.state = "ROLLING";
      if (!current.rollovers.some(r => r.id === stableId)) current.rollovers.push({ id: stableId, fromGroupId: group.id, toGroupId, state: "PREPARED", epoch: current.epoch, createdAt: this.now() }); });
    c = await this.get(c.id); const step = c.rollovers.find(s => s.id === stableId)!;
    if (!this.active(c, t)) return;
    if (step.state === "PREPARED") {
      const send = await this.change(c.id, current => { const s = current.rollovers.find(s => s.id === stableId)!;
        if (!this.active(current, t) || current.exitRequested || current.flattenRequested || s.state !== "PREPARED" || s.epoch !== current.epoch) return false; s.state = "DISPATCHED"; return true; });
      if (send) {
        const allowed = () => !this.halted && this.generation === t.generation;
        if (!allowed()) return;
        try { await this.rollFact(c.id, stableId, await this.connector.rollover(c, step, allowed)); }
        catch { await this.change(c.id, current => { const s = current.rollovers.find(s => s.id === stableId)!; if (s.state !== "CREDITED") s.state = "UNKNOWN"; }); await this.pause(c.id, undefined, "EXPERIMENT_ROLLOVER_UNKNOWN",t); return; }
      }
    } else if (step.state !== "CREDITED") {
      const fact = await this.connector.lookupRollover(c, step);
      await this.rollFact(c.id, stableId, fact);
      // A positive PENDING query can advance only the runtime's persisted,
      // stable-id unsent funding rows. UNKNOWN never invokes a write callback.
      const fresh = await this.get(c.id), now = fresh.rollovers.find(s => s.id === stableId)!;
      // The step as saved by this lookup (an UNKNOWN step a PENDING answer made DISPATCHED
      // again continues in this same pass, not one retry later).
      // Every row sent and only awaiting its credit: the lookup just checked it (review P3).
      if (now.state === "DISPATCHED" && fact.state === "PENDING" && fact.waitingCode !== "RECEIPT_PENDING_QUERY_ONLY" && this.active(fresh, t) && !fresh.exitRequested && !fresh.flattenRequested) {
        const allowed = () => !this.halted && this.generation === t.generation;
        await this.rollFact(c.id, stableId, await this.connector.rollover(fresh, step, allowed));
      }
    }
    await this.change(c.id, current => { const s = current.rollovers.find(s => s.id === stableId)!; if (!this.active(current, t) || current.exitRequested || s.state !== "CREDITED") return;
      current.groups[current.activeGroup]!.completedAt = this.now();
      if (last) current.state = "COMPLETED"; else { current.activeGroup++; current.state = "RUNNING"; } });
  }
  /**
   * Pair rolling (A): instead of finishGroup. Every step under way is carried on (query first,
   * then only its unsent rows are sent); each pair done and proven flat gets its own step to
   * the same pair of the next group; a group's pairs routed back to F go together in one step
   * once all of them are done (F's payouts are still matched all-or-nothing). One step's
   * trouble holds only that step's chain. See PAIR_ROLLING_CN.md.
   */
  private async finishPairs(c: ExperimentCampaign, t: Token) {
    const now = () => this.now();
    const ready = (id: string) => (this.stepAt.get(id) ?? 0) <= now();
    // 1. Pairs downstream of a pair set aside never get money: they end too.
    if (c.groups.some(g => g.pairs.some(p => p.setAsideAt !== undefined && targetPair(c, p.id)?.state === "WAITING" && !pairFunded(c, targetPair(c, p.id)!) && !targetPair(c, p.id)!.rounds.length)))
      await this.change(c.id, current => { if (!this.active(current, t)) return;
        for (const g of current.groups) for (const p of g.pairs) {
          if (p.setAsideAt === undefined) continue;
          for (let q = targetPair(current, p.id); q && q.state === "WAITING" && !q.rounds.length && !pairFunded(current, q); q = targetPair(current, q.id)) {
            q.state = "COMPLETED"; q.setAsideAt = now(); q.setAsideCode = SOURCE_SET_ASIDE; q.errorCode = "EXPERIMENT_PAIR_SET_ASIDE";
            this.emit({ event: "pair_set_aside", level: "warn", campaignId: current.id, pairId: q.id, data: { code: SOURCE_SET_ASIDE } });
          }
        } });
    c = await this.get(c.id); if (!this.active(c, t)) return;
    // 2. Steps already under way (an exit only carries them on, see finishGroup).
    if (c.exitRequested) await this.change(c.id, current => { if (this.active(current, t)) current.rollovers = current.rollovers.filter(s => s.state !== "PREPARED"); });
    for (const step of (await this.get(c.id)).rollovers.filter(s => s.state !== "CREDITED" && ready(s.id)))
      await this.advanceStep(c.id, step.id, t);
    c = await this.get(c.id); if (!this.active(c, t)) return;
    // 3. New steps: never on exit, pause-and-flatten or for a pair in the end-of-task pass.
    if (!c.exitRequested && !c.flattenRequested) {
      const proven = async (pairs: ExperimentPair[]) => {
        // Fresh flat proof of every wallet moved (reads only), as for a whole group.
        const proofs = await Promise.allSettled(pairs.map(async p => {
          const fact = await this.snapshot(c, p, true, true);
          if (signed(fact.a.positionX18) || signed(fact.b.positionX18) || fact.a.openDigests.length || fact.b.openDigests.length) refuse("EXPERIMENT_ROLLOVER_NOT_FLAT");
        }));
        return proofs.every(r => r.status === "fulfilled");
      };
      const done = (p: ExperimentPair) => p.state === "COMPLETED" && p.setAsideAt === undefined && !p.catchUp && p.handedOffAt === undefined;
      for (const p of c.groups.flatMap(g => g.pairs).filter(p => done(p) && targetPair(c, p.id) && !outgoingStep(c, p) && ready(pairStepId(c, p.id)))) {
        if (!(await proven([p]))) { this.stepAt.set(pairStepId(c, p.id), now() + EXPERIMENT_RETRY_MS); continue; }
        const at = pairPlace(c, p.id)!, id = pairStepId(c, p.id);
        await this.change(c.id, current => { if (!this.active(current, t) || current.exitRequested || current.flattenRequested || current.rollovers.some(s => s.id === id)) return;
          const fresh = pairById(current, p.id); if (!fresh || !done(fresh)) return;
          current.rollovers.push({ id, fromGroupId: current.groups[at.group]!.id, toGroupId: current.groups[at.group + 1]!.id, pairId: p.id, state: "PREPARED", epoch: current.epoch, createdAt: now() }); });
        await this.advanceStep(c.id, id, t);
        c = await this.get(c.id); if (!this.active(c, t)) return;
      }
      for (let g = 0; g < c.groups.length; g++) {
        const back = c.groups[g]!.pairs.filter(p => !targetPair(c, p.id)), id = returnsStepId(c, g);
        if (!back.length || c.rollovers.some(s => s.id === id) || !ready(id)) continue;
        if (!back.every(p => p.state === "COMPLETED" && !p.catchUp) || !back.some(p => p.setAsideAt === undefined)) continue;
        if (!(await proven(back.filter(p => p.setAsideAt === undefined)))) { this.stepAt.set(id, now() + EXPERIMENT_RETRY_MS); continue; }
        await this.change(c.id, current => { if (!this.active(current, t) || current.exitRequested || current.flattenRequested || current.rollovers.some(s => s.id === id)) return;
          // A rejoin while the flat reads were in flight invalidates this proof set.
          if (!back.every(p => { const fresh = pairById(current, p.id); return fresh?.state === "COMPLETED" && !fresh.catchUp && fresh.setAsideAt === p.setAsideAt; })) return;
          current.rollovers.push({ id, fromGroupId: current.groups[g]!.id, toGroupId: FUNDING_ROUTE_TARGET, returnsOnly: true,
            pairIds: back.filter(p => p.setAsideAt === undefined).map(p => p.id), state: "PREPARED", epoch: current.epoch, createdAt: now() }); });
        await this.advanceStep(c.id, id, t);
        c = await this.get(c.id); if (!this.active(c, t)) return;
      }
    }
    // 4. Book-keeping: pairs whose money arrived are handed off; groups and the task complete.
    await this.change(c.id, current => { if (!this.active(current, t)) return;
      for (const step of current.rollovers.filter(s => s.state === "CREDITED")) {
        const from = current.groups.find(g => g.id === step.fromGroupId);
        // Only the pairs the step itself moved (fixed at its creation), each done and not in the
        // end-of-task pass.
        const ids = step.pairId !== undefined ? [step.pairId] : step.pairIds ?? [];
        for (const p of from?.pairs.filter(p => ids.includes(p.id)) ?? []) if (p.state === "COMPLETED" && !p.catchUp) p.handedOffAt ??= now();
      }
      const resolved = (p: ExperimentPair) => p.handedOffAt !== undefined || p.setAsideAt !== undefined || (p.catchUp === true && p.state === "COMPLETED");
      const open = current.rollovers.some(s => s.state !== "CREDITED");
      // The end-of-task pass for pairs set aside (not those that never got money), as in finishGroup.
      if (!current.exitRequested && !open && current.catchUpPassAt === undefined && current.groups.every(g => g.pairs.every(resolved)) &&
        current.groups.some(g => g.pairs.some(p => p.setAsideAt !== undefined && p.setAsideCode !== SOURCE_SET_ASIDE))) {
        current.catchUpPassAt = now(); let first = current.groups.length - 1;
        current.groups.forEach((g, i) => { for (const p of g.pairs) if (p.setAsideAt !== undefined && p.setAsideCode !== SOURCE_SET_ASIDE) {
          first = Math.min(first, i);
          p.state = "PAUSED"; p.retryAt = now(); p.retryCount = undefined; p.errorCode = undefined; p.catchUp = true;
          p.setAsideAt = undefined; p.setAsideCode = undefined; p.closeOnlyAt = undefined; p.closeOnlyCode = undefined; p.lonelySince = undefined;
        } });
        this.emit({ event: "catch_up_pass", level: "info", campaignId: current.id, data: { group: first } });
      }
      // A payout to F that needs the operator is said on the task too, and cleared once none does.
      const review = current.rollovers.find(s => s.state !== "CREDITED" && RECEIPT_REVIEW.includes(s.errorCode ?? ""))?.errorCode;
      if (review) current.errorCode ??= review;
      else if (RECEIPT_REVIEW.includes(current.errorCode ?? "")) current.errorCode = undefined;
      for (const g of current.groups) if (g.completedAt === undefined && g.pairs.every(resolved)) g.completedAt = now();
      const first = current.groups.findIndex(g => g.completedAt === undefined || g.pairs.some(p => !resolved(p)));
      current.activeGroup = first < 0 ? current.groups.length - 1 : first;
      // Done: every pair resolved and no transfer open; on exit, every pair that got money is closed.
      const finished = current.exitRequested ? livePairs(current).every(p => p.state === "COMPLETED") : first < 0;
      if (finished && !open) current.state = "COMPLETED";
    });
  }
  /** One transfer step (whole group or pair rolling): a new one is claimed (DISPATCHED) and
   *  handed to the connector; one under way is looked up first and only its unsent rows are
   *  sent. Pair rolling: a failure marks only this step, which is looked at again later. */
  private async advanceStep(id: string, stepId: string, t: Token) {
    const c = await this.get(id), step = c.rollovers.find(s => s.id === stepId);
    if (!step || step.state === "CREDITED" || !this.active(c, t)) return;
    const allowed = () => !this.halted && this.generation === t.generation;
    this.stepAt.set(stepId, this.now() + PAIR_STEP_RECHECK_MS);
    try {
      if (step.state === "PREPARED") {
        const send = await this.change(id, current => { const s = current.rollovers.find(s => s.id === stepId)!;
          if (!this.active(current, t) || current.exitRequested || current.flattenRequested || s.state !== "PREPARED" || s.epoch !== current.epoch) return false; s.state = "DISPATCHED"; return true; });
        if (!send || !allowed()) return;
        try { await this.rollFact(id, stepId, await this.connector.rollover(c, step, allowed)); }
        catch (e) { await this.change(id, current => { const s = current.rollovers.find(s => s.id === stepId)!; if (s.state !== "CREDITED") { s.state = "UNKNOWN"; s.errorCode = "EXPERIMENT_ROLLOVER_UNKNOWN"; } }); throw e; }
        return;
      }
      const fact = await this.connector.lookupRollover(c, step);
      if (c.exitRequested && fact.notStarted && fact.id === step.id && fact.identityMatches) {
        await this.change(id, current => { if (this.active(current, t)) current.rollovers = current.rollovers.filter(s => s.id !== stepId); });
        return;
      }
      await this.rollFact(id, stepId, fact);
      const fresh = await this.get(id), now = fresh.rollovers.find(s => s.id === stepId)!;
      // Every row already sent and only awaiting its credit: the lookup has just checked it,
      // a second (sending) pass would only read the same balances again.
      if (now.state === "DISPATCHED" && fact.state === "PENDING" && !NO_SEND_PASS.includes(fact.waitingCode ?? "") && this.active(fresh, t) && !fresh.flattenRequested) {
        if (fresh.exitRequested) { if (this.connector.abandonUnsentRollover) await this.rollFact(id, stepId, await this.connector.abandonUnsentRollover(fresh, now)); }
        else await this.rollFact(id, stepId, await this.connector.rollover(fresh, now, allowed));
      }
    } catch (e) {
      // Query-first on the next look; the rest of the task goes on meanwhile. Its reason is kept
      // on the step (shown on the group), never retried silently (review of A, C1).
      this.stepAt.set(stepId, this.now() + ROLLOVER_RETRY_MS);
      const code = experimentErrorCode(e);
      await this.change(id, current => { const s = current.rollovers.find(s => s.id === stepId); if (s && s.state !== "CREDITED" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) s.errorCode = code; }).catch(() => {});
    }
  }
  async tick(id?: string): Promise<ExperimentCampaign[]> {
    if (this.halted || this.busy) return this.query(id);
    this.busy = true;
    try {
      for (let c of await this.query(id)) {
        if (c.hiddenAt !== undefined || !["RUNNING", "EXITING", "ROLLING"].includes(c.state)) continue;
        const t = { epoch: c.epoch, generation: this.generation };
        try {
          // Whole-group mode: the active group's pairs. Pair rolling: every funded pair of the
          // task; the concurrency limit then counts over the whole task.
          const now = this.now(), pool = livePairs(c);
          const due = (p: ExperimentPair) => p.state === "PAUSED" && p.retryAt !== undefined && now >= p.retryAt;
          // Live/unknown risk retains its slot, including set-aside pairs. A flat rejoin
          // with completed history must acquire a slot exactly like a fresh pair.
          let active = pool.filter(occupiesPairSlot).length;
          const selected: ExperimentPair[] = [];
          for (const p of pool) {
            if (p.state === "COMPLETED" || (p.state === "PAUSED" && !due(p))) continue;
            const fresh = !occupiesPairSlot(p);
            if (fresh && !c.exitRequested && active >= (c.maxConcurrency ?? 1)) continue;
            if (fresh) active++;
            selected.push(p);
          }
          const resuming = selected.filter(due);
          if (resuming.length) await this.change(c.id, current => { if (!this.active(current, t)) return;
            for (const p of livePairs(current)) if (resuming.some(r => r.id === p.id) && p.state === "PAUSED") { p.state = p.rounds.length ? "ACTIVE" : "WAITING"; p.retryAt = undefined; } });
          // Pairs advance independently: one slow read or order wait never holds the
          // others. Every write still goes through the store's serialized update, and a
          // blocked pair pauses only itself.
          // Settled, never short-circuited: the tick (and `busy`) ends only after every pair.
          // A pair a wake-up is stepping right now is left to that runner (see lane).
          await Promise.allSettled(selected.map(p => this.lane(c, p, t)));
          c = await this.get(c.id);
          // Pause-and-flatten ends once every pair of the group is flat: the task stops in
          // a resumable state (no rollover or new money movement is started meanwhile).
          if (this.active(c, t) && c.flattenRequested) {
            // A pair waiting for the operator (no automatic retry) cannot be closed by the
            // engine; it is left to the operator and does not keep the pause from completing.
            const open = livePairs(c).some(p => { const r = last(p); return r !== undefined && r.state !== "COMPLETED" && !(p.state === "PAUSED" && p.retryAt === undefined); });
            if (!open) { await this.change(c.id, current => { current.flattenRequested = undefined; }); await this.stop(c.id);
              // The runtime withdraws makers still resting for pairs left to the operator.
              this.emit({ event: "flatten_completed", level: "info", campaignId: c.id }); }
            continue;
          }
          // The group waits only on pairs that keep failing the same non-network way: each
          // gets PAIR_LONELY_MS close-only, then PAIR_LONELY_MS more before it is set aside.
          const unfinished = c.groups[c.activeGroup]!.pairs.filter(p => p.state !== "COMPLETED");
          // Pair rolling: no pair waits for another, so a stuck pair's clock starts when it is
          // stuck (same two stages and times), not once the rest of its group is done.
          if (this.active(c, t) && isPairRolling(c) && !c.flattenRequested && livePairs(c).some(p => p.state === "PAUSED" || p.lonelySince !== undefined))
            await this.change(c.id, current => { if (!this.active(current, t)) return;
              for (const p of livePairs(current)) {
                if (p.state === "COMPLETED") continue;
                const stuck = p.state === "PAUSED" && p.errorCode !== undefined && !isTransientExperimentError(p.errorCode) && p.errorCode !== "EXPERIMENT_PAIR_NEEDS_REVIEW";
                if (!stuck) { p.lonelySince = undefined; continue; }
                p.lonelySince ??= now;
                if (p.closeOnlyAt === undefined && now - p.lonelySince >= PAIR_LONELY_MS) this.closeOnly(current.id, p, p.errorCode!, now);
                else if (p.closeOnlyAt !== undefined && now - Math.max(p.closeOnlyAt, p.lonelySince) >= PAIR_LONELY_MS) this.setAside(current.id, p, p.errorCode!, now);
              } });
          else if (this.active(c, t) && !isPairRolling(c) && unfinished.length && unfinished.length < c.groups[c.activeGroup]!.pairs.length && !c.flattenRequested)
            await this.change(c.id, current => { if (!this.active(current, t)) return;
              for (const p of current.groups[current.activeGroup]!.pairs) {
                if (p.state === "COMPLETED") continue;
                const stuck = p.state === "PAUSED" && p.errorCode !== undefined && !isTransientExperimentError(p.errorCode) && p.errorCode !== "EXPERIMENT_PAIR_NEEDS_REVIEW";
                if (!stuck) { p.lonelySince = undefined; continue; }
                if (!current.groups[current.activeGroup]!.pairs.every(q => q.id === p.id || q.state === "COMPLETED" ||
                  (q.state === "PAUSED" && q.errorCode !== undefined && !isTransientExperimentError(q.errorCode)))) continue;
                p.lonelySince ??= now;
                if (p.closeOnlyAt === undefined && now - p.lonelySince >= PAIR_LONELY_MS) this.closeOnly(current.id, p, p.errorCode!, now);
                else if (p.closeOnlyAt !== undefined && now - Math.max(p.closeOnlyAt, p.lonelySince) >= PAIR_LONELY_MS) this.setAside(current.id, p, p.errorCode!, now);
              } });
          if (this.active(c, t) && (c.retryAt === undefined || now >= c.retryAt)) {
            if (isPairRolling(c)) await this.finishPairs(c, t); else await this.finishGroup(c, t);
            // Written only when a retry time is to be cleared: an empty write on every pass
            // would queue every pair's orders behind a full journal save.
            if ((await this.get(c.id)).retryAt !== undefined)
              await this.change(c.id, current => { if (current.retryAt !== undefined && now >= current.retryAt && current.errorCode !== "EXPERIMENT_ROLLOVER_UNKNOWN") { current.retryAt = undefined; current.retryCount = undefined; if (current.errorCode !== "EXPERIMENT_PAIR_NEEDS_REVIEW") current.errorCode = undefined; } });
          }
        } catch (e) { await this.pause(c.id, undefined, experimentErrorCode(e),t); }
      }
    } finally { this.busy = false; }
    return this.query(id);
  }
}

/** Sorted-key JSON is the exact plaintext contract with the immutable archive. */
function archiveCanonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, child]) => [k, sort(child)]));
    return v;
  };
  // Match JSON persistence: optional undefined fields are absent, never invented.
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value))));
}
async function archiveSha256(payload: string): Promise<string> {
  if (!globalThis.crypto?.subtle) refuse("EXPERIMENT_ARCHIVE_CRYPTO_UNAVAILABLE");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
}
function archiveId(body: ExperimentCompactionBody, sha: string): string {
  return `experiment:archive:${body.chainId}:${body.mode}:${body.campaignId}:${body.groupId}:${body.pairId}:${body.fromRound}-${body.toRound}:${sha}`;
}
function archivedTotals(body: ExperimentCompactionBody): Record<string, ExperimentArchivedWalletTotals> {
  const result: Record<string, ExperimentArchivedWalletTotals> = {
    [body.a]: { quoteFilledX18: "0", feePaidX18: "0" }, [body.b]: { quoteFilledX18: "0", feePaidX18: "0" },
  };
  for (const round of body.rounds) for (const order of round.orders) {
    const stat = result[order.owner]; if (!stat) refuse("EXPERIMENT_ARCHIVE_SCOPE_MISMATCH");
    stat.quoteFilledX18 = String(BigInt(stat.quoteFilledX18) + rawAmount(order.quoteFilledX18));
    stat.feePaidX18 = String(BigInt(stat.feePaidX18) + rawAmount(order.feePaidX18));
  }
  return result;
}
/** Undefined means this round is a hard prefix barrier, never permission to skip it. */
function protectedArchiveIndex(s: DeskOperations<ExperimentCampaign>): Map<string, ProtectedOrder[]> {
  const result = new Map<string, ProtectedOrder[]>();
  for (const row of s.orders) for (const key of [`i:${row.chainId}:${row.id}`, `d:${row.chainId}:${row.digest}`]) {
    const list = result.get(key) ?? []; list.push(row); result.set(key, list);
  }
  return result;
}
function archiveableProtectedOrders(index: Map<string, ProtectedOrder[]>, c: ExperimentCampaign, p: ExperimentPair, r: ExperimentRound): ProtectedOrder[] | undefined {
  if (r.state !== "COMPLETED" || !Number.isSafeInteger(r.completedAt) || r.completedAt! < 0 ||
    !Number.isSafeInteger(p.lastFlatAt) || p.lastFlatAt! < r.completedAt!) return;
  // Legacy completion + lastFlatAt came from the same verified-flat path.
  // New records additionally preserve the exact all-zero snapshot projection.
  if (r.flatProof && (r.flatProof.aPositionX18 !== "0" || r.flatProof.bPositionX18 !== "0" ||
    r.flatProof.aOpenOrderCount !== 0 || r.flatProof.bOpenOrderCount !== 0 || r.flatProof.observedAt > r.completedAt!)) return;
  const rows: ProtectedOrder[] = [];
  for (const o of r.orders) {
    if ((o.cancelState !== undefined && o.cancelState !== "CONFIRMED") ||
      (o.state !== "TERMINAL" && o.state !== "ABORTED_UNSENT") ||
      (o.state === "TERMINAL" && !o.factKnown) ||
      (o.state === "ABORTED_UNSENT" && (o.filledX18 !== "0" || o.quoteFilledX18 !== "0" || o.feePaidX18 !== "0"))) return;
    // A simulation can never claim or prune a real protected-order row.
    if (c.mode !== "LIVE") continue;
    const related = [...new Set([...(index.get(`i:${c.chainId}:${o.id}`) ?? []), ...(index.get(`i:${c.chainId}:${c.chainId}:${o.id}`) ?? []), ...(index.get(`d:${c.chainId}:${o.digest}`) ?? [])])];
    for (const row of related) {
      if ((row.id !== o.id && row.id !== `${c.chainId}:${o.id}`) || row.digest !== o.digest || row.owner !== o.owner || row.productId !== o.productId ||
        row.quantityX18 !== o.quantityX18 || row.side !== o.side || row.priceX18 !== o.priceX18 || row.nonce !== o.nonce || row.expiration !== o.expiration ||
        row.filledX18 !== o.filledX18 || row.cleared !== true || !["ACKED", "REJECTED"].includes(row.state)) return;
      rows.push(row);
    }
  }
  return rows;
}
function archiveBody(c: ExperimentCampaign, groupId: string, p: ExperimentPair, rounds: ExperimentRound[], rows: ProtectedOrder[]): ExperimentCompactionBody {
  if (!rounds.length) refuse("EXPERIMENT_ARCHIVE_EMPTY");
  return { schemaVersion: 1, campaignId: c.id, mode: c.mode, chainId: c.chainId, productId: c.productId, groupId, pairId: p.id, a: p.a, b: p.b,
    previousArchivedRoundCount: p.archivedRoundCount ?? 0, fromRound: rounds[0]!.number, toRound: rounds[rounds.length - 1]!.number,
    count: rounds.length, rounds, protectedOrders: [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}

/** Cheap pre-check with the same thresholds as planExperimentCompactions(): whether any
 *  pair could have a round to archive. Lets writers skip the full plan on most saves. */
export function experimentCompactionDue(state: DeskOperations<ExperimentCampaign>, threshold = 23): boolean {
  return (state.experiments ?? []).some(c => c.groups.some(g => g.pairs.some(p => p.rounds.length > (c.state === "COMPLETED" || g.completedAt !== undefined || p.handedOffAt !== undefined ? 0 : threshold))));
}

/** Deterministic snapshot-only plan. No mutation, storage, keys, RPC or order I/O. */
export async function planExperimentCompactions(state: DeskOperations<ExperimentCampaign>, options: ExperimentCompactionOptions = {}): Promise<ExperimentCompactionChunk[]> {
  const snapshot = structuredClone(state), threshold = options.threshold ?? 23, keep = options.keepRecent ?? 3, maxBytes = options.maxChunkBytes ?? 512 * 1024;
  const completedOnly = threshold === 0 && keep === 0;
  if (!Number.isSafeInteger(threshold) || !Number.isSafeInteger(keep) || keep < 0 || threshold < 0 || (threshold <= keep && !completedOnly) ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 6 * 1024 * 1024) refuse("EXPERIMENT_ARCHIVE_OPTIONS_INVALID");
  validateExperiments(snapshot);
  const chunks: ExperimentCompactionChunk[] = [], encoder = new TextEncoder(), index = protectedArchiveIndex(snapshot);
  for (const c of snapshot.experiments ?? []) for (const g of c.groups) for (const p of g.pairs) {
    // 1.4.0: a finished group (its money moved on) is archived whole while the task runs,
    // like a completed task: with 1700 wallets the hot journal would otherwise grow to about
    // 11 MB by the last group, and every save (validate, copy, encrypt, back up) with it.
    // Pair rolling: a pair whose money was handed on (and credited) is done for good too.
    const complete = c.state === "COMPLETED", done = complete || g.completedAt !== undefined || p.handedOffAt !== undefined;
    const hotThreshold = done ? 0 : threshold, hotKeep = done ? 0 : keep;
    if ((!complete && completedOnly) || p.rounds.length <= hotThreshold) continue;
    const rounds: ExperimentRound[] = [], rows: ProtectedOrder[] = [];
    // Reserve scope/JSON overhead, then count each original record only once.
    let estimatedBytes = 4096;
    for (let i = 0; i < p.rounds.length - hotKeep; i++) {
      const round = p.rounds[i]!, protectedRows = archiveableProtectedOrders(index, c, p, round);
      if (protectedRows === undefined) break;
      const added = encoder.encode(archiveCanonical(round)).byteLength + protectedRows.reduce((n, row) => n + encoder.encode(archiveCanonical(row)).byteLength + 1, 0) + 1;
      if (estimatedBytes + added > maxBytes) break;
      rounds.push(round); rows.push(...protectedRows); estimatedBytes += added;
    }
    if (!rounds.length) continue;
    const body = archiveBody(c, g.id, p, rounds, rows), canonicalPayload = archiveCanonical(body);
    if (encoder.encode(canonicalPayload).byteLength > maxBytes) refuse("EXPERIMENT_ARCHIVE_CHUNK_OVERSIZE");
    const sha256 = await archiveSha256(canonicalPayload);
    chunks.push({ ...body, id: archiveId(body, sha256), sha256, canonicalPayload });
  }
  return chunks;
}

/**
 * Call only after immutable encrypted storage acknowledged these exact plaintext
 * bytes, under the same writer lock as the eventual journal save. Returns a new
 * state; it cannot attest that the caller actually persisted the archive.
 */
export async function applyExperimentCompaction(state: DeskOperations<ExperimentCampaign>, input: ExperimentCompactionChunk, archiveReceipt: ExperimentArchiveReceipt): Promise<DeskOperations<ExperimentCampaign>> {
  const next = structuredClone(state), chunk = structuredClone(input), receipt = structuredClone(archiveReceipt);
  validateExperiments(next);
  if (!chunk || !receipt || !/^[0-9a-f]{64}$/.test(chunk.sha256) || receipt.id !== chunk.id || receipt.sha256 !== chunk.sha256 || typeof chunk.canonicalPayload !== "string") refuse("EXPERIMENT_ARCHIVE_RECEIPT_MISMATCH");
  const c = next.experiments?.find(c => c.id === chunk.campaignId && c.mode === chunk.mode && c.chainId === chunk.chainId && c.productId === chunk.productId),
    g = c?.groups.find(g => g.id === chunk.groupId), p = g?.pairs.find(p => p.id === chunk.pairId);
  if (!c || !g || !p || p.a !== chunk.a || p.b !== chunk.b || (p.archivedRoundCount ?? 0) !== chunk.previousArchivedRoundCount ||
    !Number.isSafeInteger(chunk.count) || chunk.count < 1 || chunk.count > p.rounds.length) refuse("EXPERIMENT_ARCHIVE_PREFIX_CHANGED");
  const rounds = p.rounds.slice(0, chunk.count), rows: ProtectedOrder[] = [], index = protectedArchiveIndex(next);
  for (const round of rounds) {
    const related = archiveableProtectedOrders(index, c, p, round);
    if (related === undefined) refuse("EXPERIMENT_ARCHIVE_PREFIX_NOT_FINAL");
    rows.push(...related);
  }
  const body = archiveBody(c, g.id, p, rounds, rows), expectedPayload = archiveCanonical(body);
  const suppliedBody: ExperimentCompactionBody = { schemaVersion: chunk.schemaVersion, campaignId: chunk.campaignId, mode: chunk.mode, chainId: chunk.chainId, productId: chunk.productId,
    groupId: chunk.groupId, pairId: chunk.pairId, a: chunk.a, b: chunk.b, previousArchivedRoundCount: chunk.previousArchivedRoundCount,
    fromRound: chunk.fromRound, toRound: chunk.toRound, count: chunk.count, rounds: chunk.rounds, protectedOrders: chunk.protectedOrders };
  if (expectedPayload !== chunk.canonicalPayload || archiveCanonical(suppliedBody) !== expectedPayload || chunk.id !== archiveId(body, chunk.sha256) ||
    await archiveSha256(expectedPayload) !== receipt.sha256) refuse("EXPERIMENT_ARCHIVE_CONTENT_CHANGED");
  const totals = archivedTotals(body);
  for (const a of [p.a, p.b]) {
    const stat = c.wallets[a]!, total = totals[a]!;
    stat.archivedQuoteFilledX18 = String(rawAmount(stat.archivedQuoteFilledX18 ?? "0") + BigInt(total.quoteFilledX18));
    stat.archivedFeePaidX18 = String(rawAmount(stat.archivedFeePaidX18 ?? "0") + BigInt(total.feePaidX18));
  }
  (p.archives ??= []).push({ id: receipt.id, sha256: receipt.sha256, fromRound: body.fromRound, toRound: body.toRound, count: body.count,
    orderCount: rounds.reduce((n, r) => n + r.orders.length, 0), protectedOrderCount: rows.length,
    byteLength: new TextEncoder().encode(expectedPayload).byteLength, walletTotals: totals });
  p.archivedRoundCount = (p.archivedRoundCount ?? 0) + body.count;
  p.rounds.splice(0, body.count);
  const pruned = new Set(rows.map(row => `${row.chainId}:${row.id}`));
  next.orders = next.orders.filter(row => !pruned.has(`${row.chainId}:${row.id}`));
  validateExperiments(next);
  return next;
}
