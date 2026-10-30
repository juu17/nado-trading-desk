// Pair rolling (A, new tasks only): each pair hands its money to the same pair of the next
// group as soon as it is done; that pair starts once both its sides are credited. Pure
// helpers over the saved task; the old whole-group mode is unchanged (see PAIR_ROLLING_CN.md).
import { FUNDING_ROUTE_TARGET, type ExperimentCampaign, type ExperimentPair, type ExperimentRollover } from "./types.js";

export const isPairRolling = (c: Pick<ExperimentCampaign, "scheduling">): boolean => c.scheduling === "PAIR";
export const pairStepId = (c: Pick<ExperimentCampaign, "id">, pairId: string) => `experiment:${c.id}:pair:${pairId}`;
export const returnsStepId = (c: Pick<ExperimentCampaign, "id">, group: number) => `experiment:${c.id}:returns:${group}`;

/** Where a pair sits: its group's index and its slot (position) in that group. */
export function pairPlace(c: ExperimentCampaign, pairId: string): { group: number; slot: number } | undefined {
  for (let g = 0; g < c.groups.length; g++) {
    const slot = c.groups[g]!.pairs.findIndex(p => p.id === pairId);
    if (slot >= 0) return { group: g, slot };
  }
  return undefined;
}
/** The pair this one is funded from (same slot, previous group); none in the first group. */
export function sourcePair(c: ExperimentCampaign, pairId: string): ExperimentPair | undefined {
  const at = pairPlace(c, pairId);
  return at && at.group > 0 ? c.groups[at.group - 1]!.pairs[at.slot] : undefined;
}
/** The pair this one hands its money to (same slot, next group); none: it returns to F. */
export function targetPair(c: ExperimentCampaign, pairId: string): ExperimentPair | undefined {
  const at = pairPlace(c, pairId);
  return at ? c.groups[at.group + 1]?.pairs[at.slot] : undefined;
}
/** The step carrying this pair's money onward, if it exists yet. */
export function outgoingStep(c: ExperimentCampaign, p: ExperimentPair): ExperimentRollover | undefined {
  if (targetPair(c, p.id)) return c.rollovers.find(s => s.id === pairStepId(c, p.id));
  const at = pairPlace(c, p.id);
  return at ? c.rollovers.find(s => s.id === returnsStepId(c, at.group)) : undefined;
}
/** A pair may trade: the first group's always (funded by F before the start); a later one's
 *  only once the step from its source pair is credited (both sides). */
export function pairFunded(c: ExperimentCampaign, p: ExperimentPair): boolean {
  const source = sourcePair(c, p.id);
  return !source || c.rollovers.some(s => s.id === pairStepId(c, source.id) && s.state === "CREDITED");
}
/** Pairs the engine works on: the active group's (whole-group mode), or every funded pair of
 *  the task (pair rolling). */
export function livePairs(c: ExperimentCampaign): ExperimentPair[] {
  if (!isPairRolling(c)) return c.groups[c.activeGroup]?.pairs ?? [];
  return c.groups.flatMap(g => g.pairs).filter(p => pairFunded(c, p));
}
/** A pair the engine may step, found by id among the live groups (pair ids are unique). */
export function pairById(c: ExperimentCampaign, pairId: string): ExperimentPair | undefined {
  if (!isPairRolling(c)) return c.groups[c.activeGroup]?.pairs.find(p => p.id === pairId);
  for (const g of c.groups) { const p = g.pairs.find(p => p.id === pairId); if (p) return p; }
  return undefined;
}
/** A pair's group index, for reads that treat a later group's never-seen wallet as unopened. */
export function pairGroupIndex(c: ExperimentCampaign, pairId: string): number {
  return isPairRolling(c) ? pairPlace(c, pairId)?.group ?? c.activeGroup : c.activeGroup;
}
/** A step is one of this task's pair-rolling steps (or its returns to F). */
export function isPairRollingStep(c: ExperimentCampaign, step: ExperimentRollover): boolean {
  return step.pairId !== undefined || step.returnsOnly === true || (isPairRolling(c) && step.toGroupId === FUNDING_ROUTE_TARGET);
}
