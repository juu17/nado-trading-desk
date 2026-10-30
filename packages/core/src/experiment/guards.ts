// =============================================================================
// @farm/core · experiment/guards — wallet-reservation + order-admission guards for
// the capacity engine. Ported from lucklab 1.4.3 guards.ts with the Phase-A cuts:
//
//  • The circular `../funding/direct.js` (depositReady) import and `./route.js`
//    (experimentStepShards) import are CUT.
//  • The FUNDING-SETTLED cluster — `assertExperimentFundingSettled`,
//    `isOwnPersistedRollover`, `experimentDepositReady` — is REMOVED. It read the
//    dropped DeskOperations funding fields (`funding`, `onboarding`, `treasury`,
//    `collateral`, `batches`) which Phase 0 trimmed away: funding is deferred (Phase C),
//    the benchmark runs a PRE-FUNDED cohort out of band, and untrusted code never moves
//    real funds. With no in-flight funding there is nothing to settle before a start.
//  • The legacy `s.hedgeRules` check is REMOVED (hedge fields dropped, Phase C).
//  • `DeskOperations` is specialized to `DeskOperations<ExperimentCampaign>` (Phase 0
//    made the desk document generic over the campaign slot to cut the funding→experiment
//    import; the experiment layer threads its own ExperimentCampaign through).
//
// KEPT (the capacity-relevant correctness invariants, re-derived as adopted code):
//  • one wallet ↔ one unfinished task (EXPERIMENT_WALLET_IN_USE /
//    EXPERIMENT_WALLETS_IN_UNFINISHED_TASK) — correctness invariant #6.
//  • no stray unresolved ordinary order on an experiment wallet (EXPERIMENT_ORDERS_UNRESOLVED).
//  • assertExperimentOrderAdmission — the admit hook injected into OrderLedger so an
//    ordinary/manual write cannot borrow a live experiment's wallet/identity (the cut
//    circular `funding/order-ledger → experiment/guards` edge, re-wired as a hook).
// =============================================================================
import { owner, refuse, type DeskOperations, type ProtectedOrder } from "../funding/types.js";
import type { ExperimentCampaign } from "./types.js";

type DeskOps = DeskOperations<ExperimentCampaign>;

export function experimentWallets(c: ExperimentCampaign): string[] {
  return c.groups.flatMap(g => g.pairs.flatMap(p => [p.a, p.b]));
}
export function experimentHasLiveReservation(c: ExperimentCampaign): boolean {
  if (c.mode !== "LIVE" || c.state === "CREATED" || c.state === "COMPLETED") return false;
  if (["RUNNING", "EXITING", "ROLLING"].includes(c.state)) return true;
  return c.rollovers.some(s => s.state === "DISPATCHED" || s.state === "UNKNOWN") || c.groups.some(g => g.pairs.some(p => p.rounds.some(r =>
    r.orders.some(o => ["PREPARED", "DISPATCHED", "UNKNOWN"].includes(o.state) || (r.state !== "COMPLETED" && BigInt(o.filledX18) > 0n)))));
}
export function experimentOwnsWallet(s: DeskOps, address: string, chainId?: number): boolean {
  const a = owner(address);
  return !!s.experiments?.some(c => experimentHasLiveReservation(c) &&
    (chainId === undefined || c.chainId === chainId) && experimentWallets(c).includes(a));
}
export function assertExperimentsSwitchSafe(s: DeskOps): void {
  if (s.experiments?.some(c => experimentHasLiveReservation(c) || (c.mode === "SIMULATION" && ["RUNNING", "EXITING", "ROLLING"].includes(c.state))))
    refuse("EXPERIMENT_SWITCH_RECONCILE_REQUIRED");
}
export function assertExperimentWalletsAvailable(s: DeskOps, campaign: ExperimentCampaign): void {
  if (campaign.mode === "SIMULATION") return;
  const wallets = new Set(experimentWallets(campaign));
  // [Phase-A cut] assertExperimentFundingSettled(s, campaign, wallets): funding is
  // deferred (pre-funded cohort, out-of-band seed); there is no in-flight funding to settle.
  if (s.experiments?.some(c => c.id !== campaign.id && experimentHasLiveReservation(c) && experimentWallets(c).some(a => wallets.has(a))))
    refuse("EXPERIMENT_WALLET_IN_USE");
  // A wallet belongs to one unfinished task at a time: an abandoned task (e.g. a stopped
  // rehearsal) could otherwise be resumed later and trade or move the other task's money.
  // A task asked to exit may still run: it only closes its own positions and finishes.
  if (!campaign.exitRequested && s.experiments?.some(c => c.id !== campaign.id && c.mode === "LIVE" && c.chainId === campaign.chainId && c.state !== "COMPLETED" &&
    experimentWallets(c).some(a => wallets.has(a))))
    refuse("EXPERIMENT_WALLETS_IN_UNFINISHED_TASK");
  // [Phase-A cut] legacy s.hedgeRules check: hedge fields dropped (Phase C).
  const own = new Set<string>();
  for (const g of campaign.groups) for (const p of g.pairs) for (const r of p.rounds) for (const o of r.orders) own.add(o.digest);
  if (s.orders.some(o => wallets.has(o.owner) && !own.has(o.digest) && o.state !== "REJECTED" && !o.cleared))
    refuse("EXPERIMENT_ORDERS_UNRESOLVED");
}
/** Ordinary/manual writes cannot borrow an experiment's wallet or identity. Injected into
 *  OrderLedger as its `admit` hook (the cut circular funding→experiment edge). Reads only
 *  `s.experiments` (read-only on globals, per the owner-lane store guard). */
export function assertExperimentOrderAdmission(s: DeskOps, input: Omit<ProtectedOrder, "state" | "filledX18" | "createdAt">): void {
  const active = s.experiments?.filter(c => experimentHasLiveReservation(c) && c.chainId === input.chainId && experimentWallets(c).includes(input.owner)) ?? [];
  const experimentId = input.id.startsWith("experiment:") || input.id.startsWith(`${input.chainId}:experiment:`);
  if (!active.length) {
    if (experimentId) refuse("EXPERIMENT_ORDER_NOT_AUTHORIZED");
    return;
  }
  const matches = active.flatMap(c => c.groups.flatMap(g => g.pairs.flatMap(p => p.rounds.flatMap(r => r.orders.map(o => ({ c, o }))))))
    .filter(({ c, o }) => c.mode === "LIVE" && ["RUNNING", "EXITING"].includes(c.state) && o.state === "DISPATCHED" && o.epoch === c.epoch &&
      (!(c.exitRequested || c.flattenRequested) || o.reduceOnly) && (input.id === o.id || input.id === `${c.chainId}:${o.id}`) &&
      input.chainId === o.chainId && input.owner === o.owner && input.productId === o.productId && input.digest === o.digest &&
      input.quantityX18 === o.quantityX18 && input.side === o.side && input.priceX18 === o.priceX18 &&
      input.nonce === o.nonce && input.expiration === o.expiration && input.payload === o.payload);
  if (matches.length !== 1) refuse("EXPERIMENT_WALLET_RESERVED");
}
