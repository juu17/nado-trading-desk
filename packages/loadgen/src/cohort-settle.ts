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
  // SAFETY — fail CLOSED: a position counts as flat ONLY when `size` is a well-formed decimal
  // equal to 0. Anything unparseable (NaN, ±Infinity, "", whitespace, unit suffixes,
  // thousand-separators) is treated as NOT flat. A flatness gate must never report an unknown
  // or malformed size as settled — that would let round N's residue slip into round N+1.
  if (typeof size !== "string" || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(size.trim())) return false;
  return Number(size) === 0;
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
 *  Call this between rounds on the reused cohort before admitting the next round. The caller
 *  MUST block round N+1 on ANY rejection: both a CohortNotFlatError (a residue) AND a raw read
 *  failure — reads run stop-on-first-failure, so a wallet read that throws rejects this call
 *  (fail-closed) and leaves later wallets unread. Treat an errored/unresolved settle as "not
 *  settled"; never start the next round on it. */
export async function assertCohortFlatSettled(wallets: readonly string[], deps: CohortSettleDeps, opts: CohortSettleOptions = {}): Promise<void> {
  const residue = await cohortResidue(wallets, deps, opts);
  if (residue.length) throw new CohortNotFlatError(residue);
}
