import { owner, rawAmount, refuse } from "../funding/types.js";
import { FUNDING_ROUTE_TARGET, type ExperimentCampaign, type ExperimentCampaignInput, type ExperimentGroupInput, type ExperimentRollover, type ExperimentRouteApproval } from "./types.js";
import { validateRehearsalPreset } from "./rehearsalPreset.js";

/**
 * The frozen money route of a campaign. Every participating wallet has exactly one exit
 * edge: same role and slot into the next group while that group has the slot, otherwise
 * back to the funding account F. The last group returns everything to F. Initial margin
 * edges F -> first group are listed so the operator confirms the whole graph at once.
 */
export type ExperimentRouteEdgeKind = "INITIAL_MARGIN" | "GROUP_ROLLOVER" | "RETURN_TO_FUNDING";
export interface ExperimentRouteEdge {
  id: string;
  kind: ExperimentRouteEdgeKind;
  /** 0 = preparation before group 1; g = after group index g-1 completed. */
  stage: number;
  role: "A" | "B";
  /** 1-based slot inside the source group (target group for INITIAL_MARGIN). */
  slot: number;
  fromGroupId?: string;
  toGroupId?: string;
  from: string;
  to: string;
  /** Hub funding (1.5): the hub's own rollover moves exactly what this wallet (B1) moves. */
  matchAmountOf?: string;
}
export type ExperimentRouteShardKind = "USDT0_ROLLOVER" | "USDT0_RECALL";
export interface ExperimentRouteShard {
  kind: ExperimentRouteShardKind;
  rows: { owner: string; recipient: string }[];
  /** Hub funding (1.5): a single-row rollover whose amount is what this wallet sent in an
   *  earlier shard of the same step (always the step's last shard). */
  matchOf?: string;
}
/** Plan parameters an approval binds besides the wallet graph. */
export interface ExperimentRoutePlanInput extends Omit<ExperimentCampaignInput, "route" | "id" | "name"> {
  fundingAccount: string;
  /** Platform margin each first-group wallet holds before trading (x18 USDT0). */
  initialMarginX18: string;
  /** Native ETH balance each participating EOA is topped up to (wei). */
  gasTargetWei: string;
  /** First deposit that opens a later-group account so it can receive a rollover (x18 USDT0). */
  openingDepositX18: string;
  /** 1.5 hub funding (see ExperimentRouteApproval.hub). */
  hub?: "FIRST_A";
}

/** The hub wallet of a hub-funded route: the first group's first A wallet. */
export function routeHub(groups: ExperimentGroupInput[]): string {
  const a = groups[0]?.pairs[0]?.a;
  if (!a) refuse("EXPERIMENT_ROUTE_INVALID");
  return owner(a);
}
function assertGroupsRoutable(groups: ExperimentGroupInput[], fundingAccount: string, hub?: "FIRST_A") {
  const f = owner(fundingAccount);
  if (!groups.length) refuse("EXPERIMENT_ROUTE_INVALID");
  if (hub !== undefined && (hub !== "FIRST_A" || routeHub(groups) !== f)) refuse("EXPERIMENT_ROUTE_INVALID");
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]!;
    if (!group.pairs.length) refuse("EXPERIMENT_ROUTE_INVALID");
    // A larger next group would leave slots without a funding source.
    if (g > 0 && group.pairs.length > groups[g - 1]!.pairs.length) refuse("EXPERIMENT_ROUTE_NEXT_GROUP_LARGER");
    // A hub (1.5) is the one participant allowed to be the funding account: group 1, pair 1, A.
    for (const [i, p] of group.pairs.entries())
      if ((owner(p.a) === f && !(hub && g === 0 && i === 0)) || owner(p.b) === f) refuse("EXPERIMENT_ROUTE_FUNDING_IS_PARTICIPANT");
  }
}

/**
 * Hub funding (1.5) changes three things, nothing else: the hub pays no margin to itself;
 * its own exit (group 1 -> group 2, slot 1, A) moves exactly what B1 moves, the rest stays
 * in the hub; it never returns to itself (a single-group task). Every other wallet moves
 * everything, and every return goes to the hub.
 */
export function experimentRouteEdges(groups: ExperimentGroupInput[], fundingAccount: string, hub?: "FIRST_A"): ExperimentRouteEdge[] {
  assertGroupsRoutable(groups, fundingAccount, hub);
  const f = owner(fundingAccount), edges: ExperimentRouteEdge[] = [];
  groups[0]!.pairs.forEach((p, i) => {
    for (const role of ["A", "B"] as const)
      if (!(hub && i === 0 && role === "A")) edges.push({ id: `initial:${role}:${i + 1}`, kind: "INITIAL_MARGIN", stage: 0, role, slot: i + 1, toGroupId: groups[0]!.id, from: f, to: owner(role === "A" ? p.a : p.b) });
  });
  groups.forEach((group, g) => {
    const next = groups[g + 1];
    group.pairs.forEach((p, i) => {
      for (const role of ["A", "B"] as const) {
        const from = owner(role === "A" ? p.a : p.b), target = next?.pairs[i], isHub = hub !== undefined && from === f;
        if (target) edges.push({ id: `roll:${g + 1}:${role}:${i + 1}`, kind: "GROUP_ROLLOVER", stage: g + 1, role, slot: i + 1,
          fromGroupId: group.id, toGroupId: next!.id, from, to: owner(role === "A" ? target.a : target.b), ...(isHub ? { matchAmountOf: owner(p.b) } : {}) });
        else if (!isHub) edges.push({ id: `return:${g + 1}:${role}:${i + 1}`, kind: "RETURN_TO_FUNDING", stage: g + 1, role, slot: i + 1,
          fromGroupId: group.id, toGroupId: FUNDING_ROUTE_TARGET, from, to: f });
      }
    });
  });
  return edges;
}

/** Legacy campaigns (no route): serial same-role shards into a short tail group. */
export function experimentRolloverShards(from: { a: string; b: string }[], to: { a: string; b: string }[]): { owner: string; recipient: string }[][] {
  if (!from.length || !to.length || to.length > from.length) refuse("EXPERIMENT_ROLLOVER_GROUP_MISMATCH");
  const sources = from.flatMap(p => [p.a, p.b]), targets = to.flatMap(p => [p.a, p.b]);
  if (new Set(sources).size !== sources.length || new Set(targets).size !== targets.length || targets.some(a => sources.includes(a)))
    refuse("EXPERIMENT_ROLLOVER_IDENTITY_MISMATCH");
  const shards: { owner: string; recipient: string }[][] = [];
  for (let start = 0; start < from.length; start += to.length)
    shards.push(from.slice(start, start + to.length).flatMap((p, i) => [
      { owner: p.a, recipient: to[i]!.a }, { owner: p.b, recipient: to[i]!.b },
    ]));
  return shards;
}

/**
 * Exact money movements of one persisted rollover step, in execution order. Routed
 * campaigns: one rollover shard for the slots the next group has, then one recall shard
 * for every other wallet (to F). The final step is a single recall shard.
 */
export function experimentStepShards(c: ExperimentCampaign, step: ExperimentRollover): ExperimentRouteShard[] {
  const from = c.groups.find(g => g.id === step.fromGroupId);
  if (!from) refuse("EXPERIMENT_ROLLOVER_GROUP_MISMATCH");
  // Wallets of a pair set aside keep their money: they move nothing (1.4.0 unattended rule).
  const aside = new Set(from.pairs.filter(p => p.setAsideAt !== undefined).flatMap(p => [owner(p.a), owner(p.b)]));
  const keep = (shards: ExperimentRouteShard[]) => shards.map(s => ({ ...s, rows: s.rows.filter(r => !aside.has(owner(r.owner))) })).filter(s => s.rows.length);
  if (!c.route) {
    const to = c.groups.find(g => g.id === step.toGroupId);
    if (!to) refuse("EXPERIMENT_ROLLOVER_GROUP_MISMATCH");
    return keep(experimentRolloverShards(from.pairs, to.pairs).map(rows => ({ kind: "USDT0_ROLLOVER" as const, rows })));
  }
  let edges = experimentRouteEdges(c.groups, c.route.fundingAccount, c.route.hub).filter(e => e.fromGroupId === from.id);
  // Pair rolling (A): a pair's own step moves only that pair's two wallets to the same pair of
  // the next group; a group's returns step moves only its pairs routed back to F.
  if (step.pairId !== undefined) {
    const slot = from.pairs.findIndex(p => p.id === step.pairId) + 1;
    if (slot < 1 || step.returnsOnly) refuse("EXPERIMENT_ROLLOVER_GROUP_MISMATCH");
    edges = edges.filter(e => e.slot === slot);
    if (edges.length !== 2 || edges.some(e => e.kind !== "GROUP_ROLLOVER")) refuse("EXPERIMENT_ROLLOVER_GROUP_MISMATCH");
    const matched = edges.find(e => e.matchAmountOf !== undefined);
    // The hub's pair (1.5): B1 first, then the hub with B1's amount.
    if (matched) return [{ kind: "USDT0_ROLLOVER", rows: edges.filter(e => e !== matched).map(e => ({ owner: e.from, recipient: e.to })) },
      { kind: "USDT0_ROLLOVER", rows: [{ owner: matched.from, recipient: matched.to }], matchOf: matched.matchAmountOf! }];
  } else if (step.returnsOnly) {
    if (step.toGroupId !== FUNDING_ROUTE_TARGET || !step.pairIds?.length) refuse("EXPERIMENT_ROLLOVER_GROUP_MISMATCH");
    const slots = new Set(step.pairIds.map(id => from.pairs.findIndex(p => p.id === id) + 1));
    if (slots.has(0)) refuse("EXPERIMENT_ROLLOVER_GROUP_MISMATCH");
    edges = edges.filter(e => e.kind === "RETURN_TO_FUNDING" && slots.has(e.slot));
    // A hub (1.5) never returns to itself: its slot has only B1's return.
    const hubStays = c.route.hub !== undefined && from.id === c.groups[0]!.id && slots.has(1) ? 1 : 0;
    if (edges.length !== 2 * slots.size - hubStays) refuse("EXPERIMENT_ROLLOVER_GROUP_MISMATCH");
  }
  // A pair-rolling step's rows were fixed when it was created (its pair, or the pairs it
  // records): what is set aside later never changes them.
  if (step.pairId !== undefined || step.returnsOnly) {
    const order = (a: ExperimentRouteEdge, b: ExperimentRouteEdge) => a.slot - b.slot || (a.role < b.role ? -1 : a.role > b.role ? 1 : 0);
    const sorted = [...edges].sort(order).map(e => ({ owner: e.from, recipient: e.to }));
    return [{ kind: step.returnsOnly ? "USDT0_RECALL" as const : "USDT0_ROLLOVER" as const, rows: sorted }];
  }
  const toGroup = step.toGroupId === FUNDING_ROUTE_TARGET ? undefined : c.groups.find(g => g.id === step.toGroupId);
  if (step.toGroupId !== FUNDING_ROUTE_TARGET && !toGroup) refuse("EXPERIMENT_ROLLOVER_GROUP_MISMATCH");
  const order = (a: ExperimentRouteEdge, b: ExperimentRouteEdge) => a.slot - b.slot || (a.role < b.role ? -1 : a.role > b.role ? 1 : 0);
  const rolls = edges.filter(e => e.kind === "GROUP_ROLLOVER").sort(order), returns = edges.filter(e => e.kind === "RETURN_TO_FUNDING").sort(order);
  if (rolls.some(e => e.toGroupId !== step.toGroupId) || (!toGroup && rolls.length)) refuse("EXPERIMENT_ROLLOVER_GROUP_MISMATCH");
  const shards: ExperimentRouteShard[] = [], matched = rolls.find(e => e.matchAmountOf !== undefined), plain = rolls.filter(e => e !== matched);
  if (plain.length) shards.push({ kind: "USDT0_ROLLOVER", rows: plain.map(e => ({ owner: e.from, recipient: e.to })) });
  if (returns.length) shards.push({ kind: "USDT0_RECALL", rows: returns.map(e => ({ owner: e.from, recipient: e.to })) });
  // The hub's own rollover (1.5) is always last: B1's amount is known by then, and skipping
  // it (B1 moved nothing) leaves every earlier shard's position unchanged.
  if (matched) shards.push({ kind: "USDT0_ROLLOVER", rows: [{ owner: matched.from, recipient: matched.to }], matchOf: matched.matchAmountOf! });
  return keep(shards);
}

function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, child]) => [k, sort(child)]));
    return v;
  };
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value))));
}
async function sha256(payload: string): Promise<string> {
  if (!globalThis.crypto?.subtle) refuse("EXPERIMENT_ROUTE_CRYPTO_UNAVAILABLE");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
}

/** Every value whose change must invalidate an operator confirmation. */
export function experimentRoutePlanDocument(plan: ExperimentRoutePlanInput) {
  validateRehearsalPreset(plan, false);
  rawAmount(plan.initialMarginX18); rawAmount(plan.gasTargetWei); rawAmount(plan.openingDepositX18);
  // A pair's own market (1.4.0) is confirmed with the route; only when set, so digests of
  // plans confirmed before are unchanged.
  const groups = plan.groups.map(g => ({ id: g.id, pairs: g.pairs.map(p => ({ id: p.id, a: owner(p.a), b: owner(p.b), ...(p.productId !== undefined ? { productId: p.productId } : {}) })) }));
  return {
    schema: "lucklab-route-v1",
    chainId: plan.chainId, mode: plan.mode, walletUsePlanId: plan.walletUsePlanId ?? null, productId: plan.productId,
    targetNotionalPerWalletX18: plan.targetNotionalPerWalletX18, orderNotionalX18: plan.orderNotionalX18,
    maxLossPerWalletX18: plan.maxLossPerWalletX18 ?? null, maxFeePerWalletX18: plan.maxFeePerWalletX18 ?? null,
    sizing: plan.sizing ?? null, slippageBps: plan.slippageBps, makerTimeoutMs: plan.makerTimeoutMs ?? 30000,
    // Only present when set, so digests of plans confirmed before these options are unchanged.
    ...(plan.closeMaker ? { closeMaker: plan.closeMaker } : {}), ...(plan.catchUpPercent && plan.catchUpPercent > 100 ? { catchUpPercent: plan.catchUpPercent } : {}),
    ...(plan.purpose ? { purpose: plan.purpose } : {}),
    ...(plan.rehearsalPreset ? { rehearsalSelection: { preset: plan.rehearsalPreset, scheduling: plan.scheduling } } : {}),
    // Round slot length (1.3.4+): only when set, so earlier confirmed digests are unchanged.
    ...(plan.slotMs !== undefined ? { slotMs: plan.slotMs } : {}),
    // Low-cost opening (1.3.2+): when set, the confirmed plan includes how it waits.
    ...(plan.costGate ? { costGate: { maxSpreadTicks: plan.costGate.maxSpreadTicks, relative: plan.costGate.relative,
      ...(plan.costGate.maxDriftBps !== undefined ? { maxDriftBps: plan.costGate.maxDriftBps } : {}), maxWaitMs: plan.costGate.maxWaitMs } } : {}),
    maxConcurrency: plan.maxConcurrency ?? 1, autoRoll: plan.autoRoll ?? false,
    fundingAccount: owner(plan.fundingAccount), initialMarginX18: plan.initialMarginX18, gasTargetWei: plan.gasTargetWei, openingDepositX18: plan.openingDepositX18,
    ...(plan.hub ? { hub: plan.hub } : {}),
    groups, edges: experimentRouteEdges(groups, plan.fundingAccount, plan.hub),
  };
}
export async function experimentRoutePlanSha256(plan: ExperimentRoutePlanInput): Promise<string> {
  return sha256(canonical(experimentRoutePlanDocument(plan)));
}
/** Recomputes the digest from the exact input being saved; a stale preview is refused. */
export async function assertExperimentRouteApproval(input: ExperimentCampaignInput): Promise<void> {
  const route = input.route;
  if (!route) return;
  const plan: ExperimentRoutePlanInput = { ...input, fundingAccount: route.fundingAccount, initialMarginX18: route.initialMarginX18,
    gasTargetWei: route.gasTargetWei, openingDepositX18: route.openingDepositX18, ...(route.hub ? { hub: route.hub } : {}) };
  if (!/^[0-9a-f]{64}$/.test(route.sha256) || await experimentRoutePlanSha256(plan) !== route.sha256) refuse("EXPERIMENT_ROUTE_CONFIRMATION_STALE");
}
export function validateRouteApproval(route: ExperimentRouteApproval, groups: ExperimentGroupInput[]): void {
  if (!route || typeof route !== "object" || !/^[0-9a-f]{64}$/.test(route.sha256) || !Number.isSafeInteger(route.confirmedAt) || route.confirmedAt < 0) refuse("EXPERIMENT_ROUTE_INVALID");
  rawAmount(route.initialMarginX18); rawAmount(route.gasTargetWei); rawAmount(route.openingDepositX18);
  // A hub pays from its Nado account: no on-chain gas or opening deposits from it.
  if (route.hub !== undefined && (route.hub !== "FIRST_A" || BigInt(route.gasTargetWei) !== 0n || BigInt(route.openingDepositX18) !== 0n)) refuse("EXPERIMENT_ROUTE_INVALID");
  assertGroupsRoutable(groups, route.fundingAccount, route.hub);
}
