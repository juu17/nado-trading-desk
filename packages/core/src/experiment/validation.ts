import { FAST_SLOT_MS, LEGACY_SLOT_MS, TURBO_SLOT_MS, roundTimingValid } from "./timing.js";
import { owner, rawAmount, refuse, type DeskOperations } from "../funding/types.js";
import { FUNDING_ROUTE_TARGET, type ExperimentCampaign, type ExperimentCampaignInput } from "./types.js";
import { validateRouteApproval } from "./route.js";
import { validateSizing } from "./sizing.js";
import { COST_GATE_CODES } from "./cost.js";
import { validateRehearsalPreset } from "./rehearsalPreset.js";

/** Pairs one group may hold, and pairs that may trade at once (1.4.0): a group is up to five
 *  plan batches of 10 pairs run together (1.3.4 and before: one batch, 10 pairs). */
// Phase-A FREE concurrency dial (decision #5): lifted off the intern's 50 (= "1–5 batches ×
// 10 pairs", a funding-rollover artifact) to cohort scale — a plan holds up to
// WALLET_INVENTORY_MAX=5000 wallets = 2500 pairs. This caps BOTH a group's pair count and
// maxConcurrency, so a single-group run can drive the whole cohort concurrently.
// ⚠️ Before actually running thousands, Phase B must bound the coordinator's own per-tick
// lane fan-out and de-O(n²) the whole-journal digest scans (density-audit findings); the
// single-IP ceiling (decision #6) is the governing limit regardless.
export const EXPERIMENT_GROUP_MAX_PAIRS = 2500;
const product = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9:_-]{1,80}$/.test(v);
const time = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const signed = (v: unknown) => typeof v === "string" && v.length <= 79 && /^-?(?:0|[1-9][0-9]*)$/.test(v);
const unsigned = (v: unknown) => typeof v === "string" && v.length <= 79 && /^(?:0|[1-9][0-9]*)$/.test(v);
/** Low-cost opening settings (see ExperimentCostGate). */
const costGateOk = (g: unknown) => {
  const x = g as Record<string, unknown> | null;
  return !!x && typeof x === "object" && Number.isSafeInteger(x.maxSpreadTicks) && Number(x.maxSpreadTicks) >= 1 && Number(x.maxSpreadTicks) <= 20 &&
    typeof x.relative === "boolean" && Number.isSafeInteger(x.maxWaitMs) && Number(x.maxWaitMs) >= 0 && Number(x.maxWaitMs) <= 3_600_000 &&
    (x.maxDriftBps === undefined || (typeof x.maxDriftBps === "number" && Number.isFinite(x.maxDriftBps) && x.maxDriftBps > 0 && x.maxDriftBps <= 100)) &&
    Object.keys(x).every((k) => ["maxSpreadTicks", "relative", "maxDriftBps", "maxWaitMs"].includes(k));
};
/** Accumulated round costs (see ExperimentCostTotals). */
const costsOk = (t: unknown) => {
  const x = t as Record<string, unknown> | null;
  return !!x && typeof x === "object" && time(x.rounds) && time(x.hedgedRounds) && Number(x.hedgedRounds) <= Number(x.rounds) &&
    ["turnoverX18", "makerFeeX18", "takerFeeX18", "hedgedTurnoverX18"].every((k) => unsigned(x[k])) &&
    ["openLegX18", "closeLegX18", "unhedgedPriceX18"].every((k) => signed(x[k])) &&
    ["gateWaitMs", "followMs", "closeFollowMs"].every(k => x[k] === undefined || time(x[k])) &&
    [["gatedRounds", "gateWaitMs"], ["followRounds", "followMs"], ["closeFollowRounds", "closeFollowMs"]].every(([count, ms]) => (x[count!] === undefined) === (x[ms!] === undefined)) &&
    (x.gatedRounds === undefined || (time(x.gatedRounds) && Number(x.gatedRounds) <= Number(x.rounds) && time(x.gateWaitMs))) &&
    (x.followRounds === undefined || (time(x.followRounds) && Number(x.followRounds) <= Number(x.rounds) && time(x.followMs))) &&
    (x.closeFollowRounds === undefined || (time(x.closeFollowRounds) && Number(x.closeFollowRounds) <= Number(x.rounds) && time(x.closeFollowMs)));
};
export function normalizeExperimentInput(input: ExperimentCampaignInput): ExperimentCampaignInput {
  if (input) validateRehearsalPreset(input);
  // Ink chain-ids (763373 | 57073) are DE-PINNED in core (the adapter supplies the real
  // value; see funding/types FundingChainId). Accept any positive safe-integer chain id.
  if (!input || !id(input.id) || !Number.isSafeInteger(input.chainId) || input.chainId <= 0 || !["LIVE", "SIMULATION"].includes(input.mode) ||
    !Number.isSafeInteger(input.productId) || input.productId <= 0 || !Number.isSafeInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 100 ||
    !Array.isArray(input.groups) || !input.groups.length || input.groups.length > 100 ||
    !Number.isSafeInteger(input.maxConcurrency ?? 1) || (input.maxConcurrency ?? 1) < 1 || (input.maxConcurrency ?? 1) > EXPERIMENT_GROUP_MAX_PAIRS ||
    (input.autoRoll !== undefined && typeof input.autoRoll !== "boolean") || (input.groups.length > 1 && !input.autoRoll) ||
    (input.makerTimeoutMs !== undefined && (!time(input.makerTimeoutMs) || input.makerTimeoutMs < 1000 || input.makerTimeoutMs > 300000)) ||
    (input.slotMs !== undefined && input.slotMs !== FAST_SLOT_MS && input.slotMs !== LEGACY_SLOT_MS && input.slotMs !== TURBO_SLOT_MS) ||
    (input.closeMaker !== undefined && input.closeMaker !== "B") || (input.selfCross !== undefined && typeof input.selfCross !== "boolean") || (input.purpose !== undefined && input.purpose !== "REHEARSAL" && input.purpose !== "SCALED_TEST") ||
    (input.catchUpPercent !== undefined && (!Number.isSafeInteger(input.catchUpPercent) || input.catchUpPercent < 100 || input.catchUpPercent > 200 || !input.sizing)) ||
    (input.costGate !== undefined && !costGateOk(input.costGate)) ||
    // Pair rolling needs the confirmed money route (every hand-over is one of its edges).
    (input.scheduling !== undefined && (input.scheduling !== "PAIR" || !input.route || (input.groups.length > 1 && !input.autoRoll)))) refuse("INVALID_EXPERIMENT_CONFIG");
  rawAmount(input.orderNotionalX18, true); rawAmount(input.targetNotionalPerWalletX18, true);
  // An absent threshold is off. Legacy plans always carry both and keep their meaning.
  if (input.maxLossPerWalletX18 !== undefined) rawAmount(input.maxLossPerWalletX18);
  if (input.maxFeePerWalletX18 !== undefined) rawAmount(input.maxFeePerWalletX18);
  if (input.sizing !== undefined) validateSizing(input.sizing);
  const groups = new Set<string>(), pairs = new Set<string>(), wallets = new Set<string>();
  const result = structuredClone(input);
  result.maxConcurrency ??= 1; result.autoRoll ??= false; result.makerTimeoutMs ??= 30000;
  for (const g of result.groups) {
    if (!id(g.id) || (result.route !== undefined && g.id === FUNDING_ROUTE_TARGET) || groups.has(g.id) || !Array.isArray(g.pairs) || !g.pairs.length || g.pairs.length > EXPERIMENT_GROUP_MAX_PAIRS) refuse("INVALID_EXPERIMENT_GROUP");
    groups.add(g.id);
    for (const p of g.pairs) {
      // A pair's own market (1.4.0, e.g. three batches on BTC and two on ETH); absent: the task's.
      if (!id(p.id) || pairs.has(p.id) || (p.productId !== undefined && !product(p.productId))) refuse("INVALID_EXPERIMENT_PAIR");
      pairs.add(p.id); p.a = owner(p.a); p.b = owner(p.b);
      if (p.a === p.b || wallets.has(p.a) || wallets.has(p.b)) refuse("EXPERIMENT_WALLET_REUSED");
      wallets.add(p.a); wallets.add(p.b);
    }
  }
  if (result.route !== undefined) {
    validateRouteApproval(result.route, result.groups);
    result.route.fundingAccount = owner(result.route.fundingAccount);
    // A hub (1.5) is the first A wallet itself (checked by validateRouteApproval).
    if (wallets.has(result.route.fundingAccount) && result.route.hub === undefined) refuse("EXPERIMENT_ROUTE_FUNDING_IS_PARTICIPANT");
  }
  return result;
}
/** The parallel readiness policy is bound to the task's own confirmed route. */
function readinessOk(c: ExperimentCampaign): boolean {
  const r = c.fundingReadiness!;
  return !!r && typeof r === "object" && r.version === 1 && r.policy === "PLATFORM_CREDIT" && !!c.route && r.routeSha256 === c.route.sha256 &&
    Number.isSafeInteger(r.confirmedAt) && r.confirmedAt > 0 && c.mode === "LIVE";
}
export function validateExperiments(s: DeskOperations<ExperimentCampaign>): void {
  if (s.experiments === undefined) return;
  try {
    if (!Array.isArray(s.experiments) || s.experiments.length > 200) refuse("JOURNAL_DAMAGED");
    const campaigns = new Set<string>();
    for (const c of s.experiments) {
      normalizeExperimentInput(c);
      if (campaigns.has(c.id) || !["CREATED", "RUNNING", "EXITING", "PAUSED", "STOPPED", "ROLLING", "COMPLETED"].includes(c.state) ||
        !time(c.epoch) || !time(c.createdAt) || !time(c.updatedAt) || !Number.isInteger(c.activeGroup) || c.activeGroup < 0 || c.activeGroup >= c.groups.length ||
        typeof c.exitRequested !== "boolean" || !c.wallets || typeof c.wallets !== "object" || !Array.isArray(c.rollovers) ||
        (c.retryAt !== undefined && !time(c.retryAt)) || (c.retryCount !== undefined && !time(c.retryCount)) ||
        (c.firstStartedAt !== undefined && !time(c.firstStartedAt)) || (c.lastStartedAt !== undefined && !time(c.lastStartedAt)) ||
        (c.flattenRequested !== undefined && c.flattenRequested !== true) || (c.resumeAfterRecovery !== undefined && c.resumeAfterRecovery !== true) || (c.resumeCount !== undefined && !time(c.resumeCount)) ||
        (c.collectionRequests !== undefined && (!Array.isArray(c.collectionRequests) || c.collectionRequests.length > 2000 ||
          c.collectionRequests.some(r => typeof r !== "string" || !r || r.length > 100))) ||
        (c.costs !== undefined && !costsOk(c.costs)) ||
        (c.fundingReadiness !== undefined && !readinessOk(c)) || (c.catchUpPassAt !== undefined && !time(c.catchUpPassAt)) ||
        (c.autoCollection !== undefined && (!c.autoCollection || typeof c.autoCollection !== "object" || !time(c.autoCollection.requestedAt) || c.autoCollection.requestedAt <= 0 ||
          Object.keys(c.autoCollection).some(k => !["requestedAt", "doneAt", "stoppedAt"].includes(k)) ||
          (c.autoCollection.doneAt !== undefined && (!time(c.autoCollection.doneAt) || c.autoCollection.doneAt <= 0)) ||
          (c.autoCollection.stoppedAt !== undefined && (!time(c.autoCollection.stoppedAt) || c.autoCollection.stoppedAt <= 0)) ||
          c.state !== "COMPLETED" || c.mode !== "LIVE")) ||
        (c.hiddenAt !== undefined && !time(c.hiddenAt))) refuse("JOURNAL_DAMAGED");
      campaigns.add(c.id);
      const orderIds = new Set<string>(), digests = new Set<string>(), archiveIds = new Set<string>(), sums = new Map<string, [bigint, bigint]>(), archivedSums = new Map<string, [bigint, bigint]>();
      for (const g of c.groups) for (const p of g.pairs) {
        if (!["WAITING", "ACTIVE", "PAUSED", "COMPLETED"].includes(p.state) || !Array.isArray(p.rounds) ||
          (p.retryAt !== undefined && !time(p.retryAt)) || (p.retryCount !== undefined && !time(p.retryCount)) ||
          (p.setAsideAt !== undefined && (!time(p.setAsideAt) || p.state !== "COMPLETED" || typeof p.setAsideCode !== "string" || !/^[A-Z][A-Z0-9_]{0,99}$/.test(p.setAsideCode))) ||
          (p.setAsideCode !== undefined && p.setAsideAt === undefined) ||
          (p.closeOnlyAt !== undefined && (!time(p.closeOnlyAt) || typeof p.closeOnlyCode !== "string" || !/^[A-Z][A-Z0-9_]{0,99}$/.test(p.closeOnlyCode))) ||
          (p.closeOnlyCode !== undefined && p.closeOnlyAt === undefined) || (p.lonelySince !== undefined && !time(p.lonelySince)) ||
          (p.catchUp !== undefined && p.catchUp !== true) || (p.handedOffAt !== undefined && (!time(p.handedOffAt) || c.scheduling !== "PAIR"))) refuse("JOURNAL_DAMAGED");
        const offset = p.archivedRoundCount ?? 0;
        if (!time(offset) || (p.archives !== undefined && !Array.isArray(p.archives))) refuse("JOURNAL_DAMAGED");
        let archivedCount = 0;
        for (const ref of p.archives ?? []) {
          if (!ref || typeof ref.id !== "string" || !ref.id.startsWith("experiment:") || ref.id.length > 600 || archiveIds.has(ref.id) ||
            !/^[0-9a-f]{64}$/.test(ref.sha256) || !time(ref.fromRound) || ref.fromRound !== archivedCount + 1 ||
            !time(ref.count) || ref.count < 1 || ref.toRound !== ref.fromRound + ref.count - 1 || !time(ref.toRound) ||
            !time(ref.orderCount) || !time(ref.protectedOrderCount) || !time(ref.byteLength) || ref.byteLength < 1 ||
            !ref.walletTotals || typeof ref.walletTotals !== "object" || Object.keys(ref.walletTotals).length !== 2) refuse("JOURNAL_DAMAGED");
          for (const a of [p.a, p.b]) {
            const total = ref.walletTotals[a]; if (!total) refuse("JOURNAL_DAMAGED");
            const sum = archivedSums.get(a) ?? [0n, 0n];
            archivedSums.set(a, [sum[0] + rawAmount(total.quoteFilledX18), sum[1] + rawAmount(total.feePaidX18)]);
          }
          archivedCount += ref.count; archiveIds.add(ref.id);
        }
        if (archivedCount !== offset) refuse("JOURNAL_DAMAGED");
        for (const a of [p.a, p.b]) {
          const stat = c.wallets[a];
          if (!stat) refuse("JOURNAL_DAMAGED");
          rawAmount(stat.quoteFilledX18); rawAmount(stat.feePaidX18); rawAmount(stat.lossX18);
          for (const n of [stat.baselineEquityX18, stat.equityX18, stat.netPnlX18, stat.realizedPnlX18]) if (n !== undefined && !signed(n)) refuse("JOURNAL_DAMAGED");
          if (stat.baselineHubInflowRaw !== undefined && (a !== c.route?.fundingAccount || !c.route?.hub || !/^(?:0|[1-9][0-9]{0,40})$/.test(stat.baselineHubInflowRaw))) refuse("JOURNAL_DAMAGED");
          for (const n of [stat.roundsWon, stat.roundsLost, stat.roundsCounted]) if (n !== undefined && !time(n)) refuse("JOURNAL_DAMAGED");
        }
        for (let i = 0; i < p.rounds.length; i++) {
          const r = p.rounds[i]!;
          // Each round keeps its own slot timing (5 minutes when absent; see timing.ts).
          if (!r.id || r.number !== offset + i + 1 || !time(r.openAt) || !time(r.holdMs) || (r.slotMs !== undefined && r.slotMs !== c.slotMs) || !roundTimingValid(r) ||
            !["BUY", "SELL"].includes(r.side) || !Array.isArray(r.orders) ||
            !["WAITING_OPEN", "A_OPEN", "CANCEL_A_OPEN", "B_OPEN", "HOLDING", "B_CLOSE_MAKER", "CANCEL_B_CLOSE_MAKER", "A_CLOSE", "CANCEL_A_CLOSE", "B_CLOSE", "VERIFYING_FLAT", "COMPLETED"].includes(r.state) ||
            (r.holdUntil !== undefined && (!time(r.pairedAt) || r.holdUntil !== r.pairedAt! + r.holdMs)) ||
            (r.completedAt !== undefined && !time(r.completedAt)) ||
            (r.earlyExitReason !== undefined && !["SOURCE_BELOW_MINIMUM_EXIT", "FOLLOWER_INCOMPLETE_EXIT", "FOLLOW_TIMEOUT_EXIT", "PAUSE_FLATTEN_EXIT", "REPRICE_EXHAUSTED_EXIT"].includes(r.earlyExitReason)) ||
            (r.plannedTurnoverX18 !== undefined && (!c.sizing || rawAmount(r.plannedTurnoverX18) <= 0n)) ||
            (r.unboostedTurnoverX18 !== undefined && (r.plannedTurnoverX18 === undefined || rawAmount(r.unboostedTurnoverX18) <= 0n || rawAmount(r.unboostedTurnoverX18) > BigInt(r.plannedTurnoverX18))) ||
            (r.result !== undefined && (r.state !== "COMPLETED" || !signed(r.result.aPnlX18) || !signed(r.result.bPnlX18))) ||
            (r.costWaitSince !== undefined && !time(r.costWaitSince)) || (r.costWaitMs !== undefined && !time(r.costWaitMs)) ||
            (r.sourceFilledAt !== undefined && !time(r.sourceFilledAt)) ||
            (r.closeSourceFilledAt !== undefined && !time(r.closeSourceFilledAt)) ||
            (r.costWaitCode !== undefined && (r.costWaitSince === undefined || !(COST_GATE_CODES as readonly string[]).includes(r.costWaitCode))) ||
            (r.flatProof !== undefined && (r.state !== "COMPLETED" || !time(r.completedAt) || !time(r.flatProof.observedAt) || r.flatProof.observedAt > r.completedAt! ||
              r.flatProof.aPositionX18 !== "0" || r.flatProof.bPositionX18 !== "0" || r.flatProof.aOpenOrderCount !== 0 || r.flatProof.bOpenOrderCount !== 0))) refuse("JOURNAL_DAMAGED");
          for (const o of r.orders) {
            if (!o.id.startsWith("experiment:") || o.id.length > 390 || orderIds.has(o.id) || digests.has(o.digest) ||
              !/^0x[0-9a-f]{64}$/.test(o.digest) || o.mode !== c.mode || o.chainId !== c.chainId || o.productId !== (p.productId ?? c.productId) ||
              ![p.a, p.b].includes(o.owner) || !["A_OPEN", "B_OPEN", "A_CLOSE", "B_CLOSE"].includes(o.role) ||
              o.owner !== (o.role.startsWith("A_") ? p.a : p.b) || typeof o.postOnly !== "boolean" ||
              // Legacy B maker closes omitted reduce-only. Read those records unchanged;
              // new sends require it, and recovery withdraws a legacy resting close first.
              (o.role === "A_OPEN" && !o.postOnly) || (o.role === "B_OPEN" && o.postOnly) ||
              (o.role === "B_CLOSE" && o.postOnly ? (c.closeMaker !== "B" || typeof o.reduceOnly !== "boolean") : o.reduceOnly !== o.role.endsWith("_CLOSE")) ||
              o.side !== (o.role === "A_OPEN" || o.role === "B_CLOSE" ? r.side : r.side === "BUY" ? "SELL" : "BUY") ||
              !["BUY", "SELL"].includes(o.side) || !["PREPARED", "DISPATCHED", "UNKNOWN", "TERMINAL", "ABORTED_UNSENT"].includes(o.state) ||
              !time(o.epoch) || o.epoch > c.epoch || !time(o.createdAt) || !time(o.expiration) || typeof o.factKnown !== "boolean" ||
              typeof o.payload !== "string" || o.payload.length > 30000 || (o.cancelEvidencePayload !== undefined && (typeof o.cancelEvidencePayload !== "string" || o.cancelEvidencePayload.length > 30000)) ||
              (o.cancelState !== undefined && !["DISPATCHED", "UNKNOWN", "CONFIRMED"].includes(o.cancelState))) refuse("JOURNAL_DAMAGED");
            rawAmount(o.quantityX18, true); rawAmount(o.priceX18, true); rawAmount(o.nonce);
            if (o.minimumHedgeQuantityX18 !== undefined && rawAmount(o.minimumHedgeQuantityX18) > BigInt(o.quantityX18) && o.role === "A_OPEN") refuse("JOURNAL_DAMAGED");
            if (rawAmount(o.filledX18) > BigInt(o.quantityX18)) refuse("JOURNAL_DAMAGED");
            const quote = rawAmount(o.quoteFilledX18), fee = rawAmount(o.feePaidX18), sum = sums.get(o.owner) ?? [0n, 0n];
            sums.set(o.owner, [sum[0] + quote, sum[1] + fee]); orderIds.add(o.id); digests.add(o.digest);
          }
        }
      }
      for (const [a, stat] of Object.entries(c.wallets)) {
        const sum = sums.get(a) ?? [0n, 0n], archive = archivedSums.get(a) ?? [0n, 0n];
        const archivedQuote = rawAmount(stat.archivedQuoteFilledX18 ?? "0"), archivedFee = rawAmount(stat.archivedFeePaidX18 ?? "0");
        if (archivedQuote !== archive[0] || archivedFee !== archive[1] || rawAmount(stat.quoteFilledX18) !== sum[0] + archivedQuote || rawAmount(stat.feePaidX18) !== sum[1] + archivedFee) refuse("JOURNAL_DAMAGED");
      }
      const rolling = new Set<string>();
      for (const step of c.rollovers) {
        if (!step.id.startsWith("experiment:") || rolling.has(step.id) || !time(step.epoch) || step.epoch > c.epoch || !time(step.createdAt) ||
          !["PREPARED", "DISPATCHED", "UNKNOWN", "CREDITED"].includes(step.state) ||
          !c.groups.some(g => g.id === step.fromGroupId) || step.fromGroupId === step.toGroupId ||
          (step.toGroupId === FUNDING_ROUTE_TARGET ? !c.route || (!step.returnsOnly && c.groups[c.groups.length - 1]!.id !== step.fromGroupId) : !c.groups.some(g => g.id === step.toGroupId)) ||
          // Pair rolling: a pair's step (to the next group) or a group's returns to F, only in such a task.
          (step.pairId !== undefined && (c.scheduling !== "PAIR" || step.returnsOnly !== undefined || step.id !== `experiment:${c.id}:pair:${step.pairId}` ||
            c.groups.findIndex(g => g.id === step.toGroupId) !== c.groups.findIndex(g => g.id === step.fromGroupId) + 1 ||
            !c.groups.find(g => g.id === step.fromGroupId)!.pairs.some(p => p.id === step.pairId))) ||
          (step.pairIds !== undefined && (step.returnsOnly !== true || !Array.isArray(step.pairIds) || !step.pairIds.length || new Set(step.pairIds).size !== step.pairIds.length ||
            step.pairIds.some(id => typeof id !== "string" || !c.groups.find(g => g.id === step.fromGroupId)!.pairs.some(p => p.id === id)))) ||
          (step.returnsOnly !== undefined && (c.scheduling !== "PAIR" || step.returnsOnly !== true || step.pairIds === undefined || step.toGroupId !== FUNDING_ROUTE_TARGET ||
            step.id !== `experiment:${c.id}:returns:${c.groups.findIndex(g => g.id === step.fromGroupId)}`))) refuse("JOURNAL_DAMAGED");
        rolling.add(step.id);
      }
    }
  } catch { refuse("JOURNAL_DAMAGED"); }
}

export function makeExperimentCampaign(input: ExperimentCampaignInput, now: number): ExperimentCampaign {
  const config = normalizeExperimentInput(input);
  if (!time(now)) refuse("INVALID_EXPERIMENT_TIME");
  return { ...config, state: "CREATED", epoch: 0, createdAt: now, updatedAt: now, activeGroup: 0,
    groups: config.groups.map(g => ({ id: g.id, pairs: g.pairs.map(p => ({ ...p, state: "WAITING", rounds: [] })) })),
    wallets: Object.fromEntries(config.groups.flatMap(g => g.pairs.flatMap(p => [p.a, p.b])).map(a => [a, { quoteFilledX18: "0", feePaidX18: "0", lossX18: "0" }])),
    rollovers: [], exitRequested: false };
}
