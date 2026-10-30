/**
 * Markets of a task (1.4.0). A task has one market (`productId`) unless pairs carry their own:
 * e.g. a group of five plan batches with three batches on BTC and two on ETH. Every order of
 * a pair is in the pair's market; the money route is unchanged (USDT0 margin is the same for
 * every market).
 */
import type { ExperimentCampaignInput, ExperimentPairInput } from "./types.js";

export const pairProductId = (c: Pick<ExperimentCampaignInput, "productId">, p: Pick<ExperimentPairInput, "productId">): number =>
  p.productId ?? c.productId;
/** Every market the task trades, the task's own first. */
export function campaignProductIds(c: Pick<ExperimentCampaignInput, "productId" | "groups">): number[] {
  const out = [c.productId];
  for (const g of c.groups) for (const p of g.pairs) { const id = pairProductId(c, p); if (!out.includes(id)) out.push(id); }
  return out;
}
