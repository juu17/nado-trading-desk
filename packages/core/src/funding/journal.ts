// =============================================================================
// @farm/core · funding/journal — validateDeskOperations, the integrity gate for a
// persisted desk document. Ported (trimmed) from lucklab 1.4.3 to the benchmark
// subset: it validates ONLY the kept fields (schema, groups, orders, walletUsePlans,
// activeWalletUsePlanId, experiments slot, trading flags, epoch). The funding/batches/
// hedge/fills/onboarding/treasury/collateral/networkGroups/wallet-policy validation and
// their imports (direct.js, wallet-policy.js, experiment/validation.js,
// collateral-evidence.js) are DROPPED with the fields they guarded. The order chainId
// check is de-pinned from Ink 763373|57073 to a plain number.
//
// The experiments slot is validated SHALLOWLY in core (the full ExperimentCampaign
// validator is Phase A, in the experiment module — keeping it out avoids the circular
// edge). Phase A composes a deeper validator over this one.
// =============================================================================
import {
  owner,
  rawAmount,
  refuse,
  type DeskOperations,
  type ExperimentCampaignSlot,
} from "./types.js";
import { validateWalletUsePlans } from "./wallet-use-plan.js";

export function validateDeskOperations<
  C extends ExperimentCampaignSlot = ExperimentCampaignSlot,
>(input: unknown): DeskOperations<C> {
  try {
    const v = structuredClone(input) as DeskOperations<C> & { schema: number };
    if (
      !v ||
      v.schema !== 2 ||
      !v.groups ||
      typeof v.groups !== "object" ||
      Array.isArray(v.groups) ||
      !Array.isArray(v.orders) ||
      typeof v.tradingStopped !== "boolean" ||
      typeof v.stopped !== "boolean" ||
      !Number.isSafeInteger(v.epoch) ||
      v.epoch < 0
    )
      refuse("JOURNAL_DAMAGED");
    validateWalletUsePlans(v);
    // Experiments slot: shallow shape only (Phase A validates the full campaign).
    if (v.experiments !== undefined) {
      if (!Array.isArray(v.experiments)) refuse("JOURNAL_DAMAGED");
      for (const c of v.experiments)
        if (!c || typeof (c as { id?: unknown }).id !== "string" || !(c as { id: string }).id)
          refuse("JOURNAL_DAMAGED");
    }
    for (const [a, g] of Object.entries(v.groups))
      if (owner(a) !== a || !["A", "B"].includes(g)) refuse("JOURNAL_DAMAGED");
    const ids = new Set<string>();
    for (const o of v.orders) {
      if (
        !o ||
        typeof o.id !== "string" ||
        !o.id ||
        o.id.length > 400 ||
        ids.has(o.id) ||
        owner(o.owner) !== o.owner ||
        !/^0x[0-9a-f]{64}$/.test(o.digest) ||
        !Number.isSafeInteger(o.productId) ||
        o.productId <= 0 ||
        // De-pinned: any POSITIVE safe-integer chain id (the adapter owns the valid
        // set; Ink's 763373/57073 are no longer hardcoded). Chain ids are positive.
        typeof o.chainId !== "number" ||
        !Number.isSafeInteger(o.chainId) ||
        o.chainId <= 0 ||
        !["BUY", "SELL"].includes(o.side) ||
        !["DISPATCHED", "UNKNOWN", "ACKED", "REJECTED"].includes(o.state) ||
        typeof o.payload !== "string" ||
        o.payload.length > 30000 ||
        (o.neverSent !== undefined && typeof o.neverSent !== "boolean") ||
        (o.neverSent === true && (o.state !== "REJECTED" || o.filledX18 !== "0" || o.cleared !== true)) ||
        (o.cancelEvidencePayload !== undefined && (typeof o.cancelEvidencePayload !== "string" || o.cancelEvidencePayload.length > 30000)) ||
        (o.iocEvidencePayload !== undefined && (typeof o.iocEvidencePayload !== "string" || o.iocEvidencePayload.length > 2048)) ||
        (o.purpose !== undefined && o.purpose !== "RISK_CLOSE") ||
        (o.dispatchCount !== undefined && (o.purpose !== "RISK_CLOSE" || ![0, 1].includes(o.dispatchCount))) ||
        !Number.isSafeInteger(o.expiration)
      )
        refuse("JOURNAL_DAMAGED");
      ids.add(o.id);
      rawAmount(o.quantityX18, true);
      rawAmount(o.priceX18, true);
      rawAmount(o.nonce);
      if (rawAmount(o.filledX18) > BigInt(o.quantityX18))
        refuse("JOURNAL_DAMAGED");
    }
    return v;
  } catch {
    return refuse("JOURNAL_DAMAGED");
  }
}
