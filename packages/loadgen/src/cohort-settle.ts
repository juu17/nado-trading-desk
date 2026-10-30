// =============================================================================
// @farm/loadgen · cohort-settle — the between-rounds flat+settled gate (A-6 / decision #3).
// The benchmark REUSES one pre-funded cohort across rounds, so before starting round N+1 on
// those wallets we must prove the cohort is fully flat: zero net position AND zero open
// orders on every wallet, in the traded market. Otherwise round N's late close/recall could
// still land mid-N+1, corrupting both the positions and the measured fills.
//
// Harness-native (not folded from the intern's 1.5 guards start-gate, which needs the
// deferred collateral.inFlight). In Phase A (pre-funded, no funding/rollover) there is no
// in-flight on-chain recall to wait on — the flat check is positions + open orders. The
// `inFlightRecall` hook is a seam for Phase C to add the collateral settle wait without
// changing callers.
//
// Reads run on bounded lanes (one shared per-IP budget, decision #6): the gate reads every
// wallet, so it respects the same egress ceiling as the trading path.
// =============================================================================
import { runLanes } from "@farm/core";
import type { NadoGateway } from "@farm/adapter-nado";

export interface CohortSettleDeps {
  /** A per-wallet gateway view (createMultiWalletNadoGateway().forOwner). */
  forOwner(owner: string): NadoGateway;
}

export interface CohortSettleOptions {
  /** Subaccount label the sequencer reads form with the owner (default "default"). */
  subaccount?: string;
  /** Max wallets read concurrently against the single-IP budget (default 4). */
  lanes?: number;
  /** Market ids to check open orders in; positions are checked across all markets the
   *  gateway reports. Defaults to every market with a non-flat position or any open order. */
  markets?: string[];
  /** Phase-C seam: resolve to true while an on-chain recall for `owner` is still in flight
   *  (collateral settle). Absent in Phase A (no funding). */
  inFlightRecall?: (owner: string) => Promise<boolean> | boolean;
}

export interface WalletResidue {
  owner: string;
  /** Markets where a non-zero net position remains. */
  openPositions: string[];
  /** Count of resting orders across markets. */
  openOrderCount: number;
  /** True when a Phase-C recall is still in flight (always false in Phase A). */
  recallInFlight: boolean;
}

export class CohortNotFlatError extends Error {
  constructor(readonly residue: WalletResidue[]) {
    super("COHORT_NOT_FLAT");
    this.name = "CohortNotFlatError";
  }
}

const isFlatSize = (size: string): boolean => {
  // Position sizes are human decimals; treat any non-zero magnitude as not flat.
  const n = Number(size);
  return !Number.isFinite(n) || n === 0;
};

/** Read one wallet's residue: its non-flat positions, resting order count, and (Phase C) any
 *  in-flight recall. Never throws for a clean wallet — returns an all-zero residue. */
export async function walletResidue(owner: string, deps: CohortSettleDeps, opts: CohortSettleOptions = {}): Promise<WalletResidue> {
  const subaccount = opts.subaccount ?? "default";
  const gw = deps.forOwner(owner);
  const [positions, openOrders] = await Promise.all([gw.getPositions(subaccount), gw.getOpenOrders(subaccount)]);
  const openPositions = positions.filter((p) => !isFlatSize(p.size)).map((p) => p.market);
  const recallInFlight = opts.inFlightRecall ? !!(await opts.inFlightRecall(owner)) : false;
  return { owner, openPositions, openOrderCount: openOrders.length, recallInFlight };
}

/** The gate: resolve the residue of every cohort wallet (on bounded lanes) and return the
 *  wallets that are NOT settled. Empty array ⇒ the cohort is flat+settled and round N+1 may start. */
export async function cohortResidue(wallets: readonly string[], deps: CohortSettleDeps, opts: CohortSettleOptions = {}): Promise<WalletResidue[]> {
  const out: WalletResidue[] = [];
  await runLanes(wallets, Math.max(1, opts.lanes ?? 4), async (owner) => {
    const r = await walletResidue(owner, deps, opts);
    if (r.openPositions.length || r.openOrderCount > 0 || r.recallInFlight) out.push(r);
  });
  return out;
}

/** Assert the cohort is flat+settled, or throw CohortNotFlatError with the offending wallets.
 *  Call this between rounds on the reused cohort before admitting the next round. */
export async function assertCohortFlatSettled(wallets: readonly string[], deps: CohortSettleDeps, opts: CohortSettleOptions = {}): Promise<void> {
  const residue = await cohortResidue(wallets, deps, opts);
  if (residue.length) throw new CohortNotFlatError(residue);
}
