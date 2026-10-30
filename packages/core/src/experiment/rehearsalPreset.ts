import { refuse } from "../funding/types.js";
import { FAST_SLOT_MS } from "./timing.js";
import type { ExperimentCampaignInput } from "./types.js";

/** Versioned selection contract; never coerces an unknown marker into an older task. */
export function rehearsalPairCount(preset: unknown): 2 | 3 | undefined {
  if (preset === undefined) return undefined;
  if (preset === "PAIR_2_V1") return 2;
  if (preset === "PAIR_3_V1") return 3;
  return refuse("EXPERIMENT_REHEARSAL_INVALID");
}
type Plan = Omit<ExperimentCampaignInput, "id" | "name" | "route"> & Pick<ExperimentCampaignInput, "route">;
/** Shape/policy only. The renderer runtime separately proves membership against the original
 * walletUsePlan snapshot; core never derives HD identities from a marker or pair-id string. */
export function validateRehearsalPreset(plan: Plan, requireRoute = true): void {
  const n = rehearsalPairCount(plan.rehearsalPreset);
  if (n === undefined) return;
  if (plan.purpose !== "REHEARSAL" || plan.mode !== "LIVE" || (requireRoute && !plan.route) ||
      plan.scheduling !== "PAIR" || plan.autoRoll !== true || plan.maxConcurrency !== n ||
      plan.productId !== 2 || plan.targetNotionalPerWalletX18 !== "5000000000000000000000" ||
      plan.sizing?.kind !== "CAPITAL_MULTIPLE" || plan.sizing.multiplier !== 10 ||
      plan.slotMs !== FAST_SLOT_MS || plan.closeMaker !== "B" ||
      plan.maxLossPerWalletX18 !== undefined || plan.maxFeePerWalletX18 !== undefined ||
      !Array.isArray(plan.groups) || plan.groups.length !== 2 || plan.groups.some((g, index) => {
        const batch = index === 0 ? 1 : 3;
        return g.id !== `group-${batch}` || !Array.isArray(g.pairs) || g.pairs.length !== n ||
          g.pairs.some((p, i) => p.id !== `pair-${batch}-${i + 1}` || (p.productId !== undefined && p.productId !== 2));
      })) refuse("EXPERIMENT_REHEARSAL_INVALID");
}
