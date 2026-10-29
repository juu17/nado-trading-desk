// =============================================================================
// @farm/core · funding/types — the DeskOperations document + its primitives, the
// state substrate the capacity-benchmark engine persists through OperationsStore.
//
// Ported (trimmed) from lucklab 1.4.3 funding/types.ts. The benchmark keeps only
// the order-path subset; onboarding/treasury/collateral/hedge/fills and the
// HD-wallet/deck policy fields are DROPPED (funding is deferred — Phase C). The
// Ink chain-id pinning (763373 | 57073) is STRIPPED to a plain `number`:
// chain-specifics are supplied by the adapter, never pinned in protocol-agnostic
// core. `experiments` is kept as an opaque, generically-typed Phase-A seam so core
// never imports the experiment module (the circular funding⇄experiment edge).
// =============================================================================

/** The chain id of a desk record. De-pinned from Ink's 763373 | 57073: core treats
 *  it as an opaque number and the adapter supplies the real value. */
export type FundingChainId = number;

/** Terminal funding states — retained as a primitive (used by callers that reason
 *  about settlement). The funding-intent machinery itself is deferred (Phase C). */
export type FundingState =
  | "PREPARED"
  | "DISPATCHED"
  | "PENDING"
  | "MINED"
  | "UNKNOWN"
  | "CONFIRMED"
  | "REVERTED"
  // Only for an intent proven never broadcast. Treated as "nothing moved".
  | "ABORTED_UNSENT";
export const TERMINAL: readonly FundingState[] = [
  "CONFIRMED",
  "REVERTED",
  "ABORTED_UNSENT",
];

/** A persisted order intent and its single-dispatch lifecycle. The engine's
 *  OrderLedger owns every transition; the row is the durable no-double-place proof. */
export interface ProtectedOrder {
  id: string;
  owner: string;
  chainId: FundingChainId;
  productId: number;
  digest: string;
  payload: string;
  quantityX18: string;
  side: "BUY" | "SELL";
  priceX18: string;
  nonce: string;
  expiration: number;
  createdAt: number;
  state: "DISPATCHED" | "UNKNOWN" | "ACKED" | "REJECTED";
  filledX18: string;
  errorCode?: string;
  cleared?: boolean;
  /** Positive local proof that the persisted intent never crossed transport. */
  neverSent?: boolean;
  /** Exact cancellation receipt retained by the protocol-specific recovery helper. */
  cancelEvidencePayload?: string;
  /** Unsigned IOC appendix and experiment identity; recompute the original typed
   * digest before use. This is never an execution/cancellation receipt. */
  iocEvidencePayload?: string;
  purpose?: "RISK_CLOSE";
  /** Passive risk close: 0 is reserved; 1 is durable permission already consumed. */
  dispatchCount?: 0 | 1;
}

/** Phase-A seam. The full campaign shape lives in the experiment module
 *  (`experiment/types.ts` → ExperimentCampaign), which Phase A ports. Core stores
 *  the slot opaquely and never reads into it — order admission against a live
 *  campaign is injected into OrderLedger via its `admit` hook, not imported here,
 *  so there is NO funding→experiment edge. Phase A specializes the document as
 *  `DeskOperations<ExperimentCampaign>`; `id` is the one field core relies on. */
export interface ExperimentCampaignSlot {
  readonly id: string;
}

/** The persisted desk document (trimmed to the benchmark subset). Generic over the
 *  campaign slot so Phase A can thread its own ExperimentCampaign through without a
 *  core→experiment import. */
export interface DeskOperations<
  C extends ExperimentCampaignSlot = ExperimentCampaignSlot,
> {
  schema: 2;
  /** Per-wallet A/B role assignment for the self-match pairs. */
  groups: Record<string, "A" | "B">;
  /** Every order intent across every wallet (the engine shards writes per owner). */
  orders: ProtectedOrder[];
  /** The funded cohort roster + its pairing (Phase-A seam; see wallet-use-plan). */
  walletUsePlans?: import("./wallet-use-plan.js").WalletUsePlan[];
  activeWalletUsePlanId?: string;
  /** Opaque Phase-A campaign slot (see ExperimentCampaignSlot). */
  experiments?: C[];
  /** Global trading halt (operator stop / harness-level fatal). */
  tradingStopped: boolean;
  /** Global persisted stop flag (distinct from an in-memory lane stop). */
  stopped: boolean;
  epoch: number;
}

export const emptyOperations = <
  C extends ExperimentCampaignSlot = ExperimentCampaignSlot,
>(): DeskOperations<C> => ({
  schema: 2,
  groups: {},
  orders: [],
  tradingStopped: true,
  stopped: true,
  epoch: 0,
});

/** The interface the engine persists through: an atomic read-modify-write over the
 *  desk document. Shape per lucklab funding/types.ts. */
export interface OperationsStore<
  C extends ExperimentCampaignSlot = ExperimentCampaignSlot,
> {
  read(): Promise<DeskOperations<C>>;
  /** Serialized atomic read-modify-write over the WHOLE document (the global lane:
   *  operator stop/enable/recover, group edits). The returned value is deep-cloned. */
  update<T>(fn: (state: DeskOperations<C>) => T): Promise<T>;
}

/** The density-critical extension: a per-wallet update lane so concurrent order
 *  writes for DIFFERENT owners do NOT serialize behind one global write-lock. The
 *  view handed to `fn` has `orders` scoped to `owner` (fast, O(owner's orders)); the
 *  commit writes back only that owner's shard. `fn` MUST mutate only this owner's
 *  orders — global-field writes belong on `update`. Updates for the same owner
 *  serialize; updates for different owners run concurrently; a global `update` is
 *  exclusive w.r.t. all owner lanes. */
export interface ShardedOperationsStore<
  C extends ExperimentCampaignSlot = ExperimentCampaignSlot,
> extends OperationsStore<C> {
  updateOwner<T>(
    owner: string,
    fn: (state: DeskOperations<C>) => T,
  ): Promise<T>;
}

export class OperationalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OperationalError";
  }
}
export function refuse(code: string): never {
  throw new OperationalError(code);
}
export function owner(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(value) ||
    /^0x0{40}$/.test(value)
  )
    return refuse("INVALID_ADDRESS");
  return value.toLowerCase();
}
export function rawAmount(value: unknown, positive = false): bigint {
  if (
    typeof value !== "string" ||
    value.length > 78 ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  )
    return refuse("INVALID_AMOUNT");
  const n = BigInt(value);
  if (n >= 1n << 256n || (positive && n === 0n))
    return refuse("INVALID_AMOUNT");
  return n;
}
export function parseAmount(value: string, decimals: number): bigint {
  if (
    typeof value !== "string" ||
    value.length > 90 ||
    !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)
  )
    return refuse("INVALID_AMOUNT");
  const [i, f = ""] = value.split(".");
  if (f.length > decimals) return refuse("INVALID_PRECISION");
  return rawAmount(
    ((i ?? "0") + f.padEnd(decimals, "0")).replace(/^0+(?=\d)/, ""),
  );
}
export function formatAmount(n: bigint, decimals: number): string {
  const s = n.toString().padStart(decimals + 1, "0"),
    a = s.slice(0, -decimals),
    b = s.slice(-decimals).replace(/0+$/, "");
  return a + (b ? "." + b : "");
}
