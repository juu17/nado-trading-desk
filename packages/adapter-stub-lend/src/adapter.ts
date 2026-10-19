// =============================================================================
// @farm/adapter-stub-lend · StubLendAdapter — a ProtocolAdapter (universal port +
// LENDING capability). Deliberately different from Nado along every axis the
// conformance suite checks: a different capability sub-interface, a disjoint op set
// (supply/borrow/repay/withdrawSupply), a different result type (TxReceiptView, not
// Order), a different account model (no subaccounts), and a different EIP-712 domain
// (ERC-2612 permit). No real backend — deterministic in-memory receipts; it imports
// ONLY @farm/adapter-api (the seam), never @farm/core or @farm/ui.
// =============================================================================
import type {
  ProtocolAdapter, ProtocolManifest, AdapterEnv, AdapterOp, RateCost, Address,
  ChainId, WalletId, AccountHandle, Balance, DataKind, StreamSink, Subscription,
  OperationKind, SignerContext, SignedPayloadPreview, ProtocolOperation, Operation,
  OpResultOf, AdapterError, SafetyLabel, CapabilityId, CapabilityMap,
  LendingCapability, LendingReserve, LendingPosition, TxReceiptView, Bps, Decimal,
} from "@farm/adapter-api";
import { STUB_LEND_MANIFEST } from "./manifest.js";

const PROTOCOL_ID = "stub-lend";
const LENDING_OPS: ReadonlySet<OperationKind> = new Set(["supply", "borrow", "repay", "withdrawSupply"]);

function adapterError(message: string, category: AdapterError["category"] = "rejected", raw?: unknown): AdapterError {
  return { category, retrySafe: category === "retryable-safe", message, raw: raw ?? null };
}

export class StubLendAdapter implements ProtocolAdapter {
  readonly manifest: ProtocolManifest = STUB_LEND_MANIFEST;
  readonly lending: LendingCapability;

  private _env?: AdapterEnv;
  private txSeq = 0;

  constructor() {
    this.lending = this.makeLending();
  }

  async init(env: AdapterEnv): Promise<void> { this._env = env; }
  async dispose(): Promise<void> { this._env = undefined; }

  // ---- universal port -------------------------------------------------------
  costOf(op: AdapterOp): RateCost[] {
    switch (op.kind) {
      case "supply":
      case "borrow":
      case "repay":
      case "withdrawSupply":
        return [{ bucket: "stublend:rpc", scope: "ip", weight: 1 }];
      default:
        return [];
    }
  }

  async resolveAccount(a: { owner: Address; chainId: ChainId; walletId?: WalletId; subaccountName?: string }): Promise<AccountHandle> {
    // No subaccounts (subaccounts: false) — a flat, owner-keyed handle.
    return { protocolId: PROTOCOL_ID, chainId: a.chainId, owner: a.owner, walletId: a.walletId, readiness: "unfunded", raw: null };
  }

  async getBalances(_a: AccountHandle): Promise<Balance[]> {
    // Deterministic stub (no backend).
    return [{ asset: "USDC", symbol: "USDC", total: "0" as Decimal, available: "0" as Decimal, scope: "spot", raw: null }];
  }

  subscribe(_targets: AccountHandle[], _kinds: DataKind[], _sink: StreamSink): Subscription {
    return { addTargets: () => {}, removeTargets: () => {}, close: () => {} };
  }

  supports(op: OperationKind): boolean {
    return this.manifest.supportedOps.includes(op);
  }

  async preview(_ctx: SignerContext, op: ProtocolOperation): Promise<SignedPayloadPreview> {
    const label = this.labelOperation(op);
    const i = op.input as { amount?: string; asset?: string; reserve?: string };
    const summary = `${op.kind} ${i.amount ?? ""} ${i.asset ?? i.reserve ?? ""}`.replace(/\s+/g, " ").trim() + " on Stub Lend";
    return { summary, signedKind: "eip712", chainId: op.chainId, method: op.kind, label, warnings: [], decodedByCore: false, raw: op };
  }

  async execute<O extends ProtocolOperation>(_ctx: SignerContext, op: O): Promise<OpResultOf<O>> {
    if (LENDING_OPS.has(op.kind)) return this.makeReceipt(op) as OpResultOf<O>;
    throw adapterError(`stub-lend does not support op '${op.kind}'`, "rejected");
  }

  // Deterministic synthetic receipt (no chain / no backend) — the conformance suite never
  // calls execute, but the lending write-wrappers route through it for a real return shape.
  private makeReceipt(op: ProtocolOperation): TxReceiptView {
    const seq = ++this.txSeq;
    return { chainId: op.chainId, hash: `0x${seq.toString(16).padStart(64, "0")}`, status: "success", raw: { stub: true, kind: op.kind } };
  }

  normalizeError(e: unknown): AdapterError {
    if (e && typeof e === "object" && "category" in e) return e as AdapterError;
    return adapterError(e instanceof Error ? e.message : String(e), "rejected", e);
  }

  labelOperation(op: Operation): SafetyLabel {
    const base: SafetyLabel = { destructive: false, grantsStandingAuth: false, movesFunds: false, requiresPrimaryKey: false, blastRadiusClass: "none" };
    if (LENDING_OPS.has(op.kind)) return { ...base, movesFunds: true, blastRadiusClass: "funds-move" };
    return base;
  }

  capability<K extends CapabilityId>(id: K): CapabilityMap[K] | undefined {
    return id === "lending" ? (this.lending as CapabilityMap[K]) : undefined;
  }

  // ---- lending capability ---------------------------------------------------
  private makeLending(): LendingCapability {
    return {
      getReserves: async (): Promise<LendingReserve[]> => [
        { reserve: "r-usdc", asset: "USDC", symbol: "USDC", supplyApy: 350 as Bps, variableBorrowApy: 520 as Bps, raw: null },
        { reserve: "r-weth", asset: "WETH", symbol: "WETH", supplyApy: 180 as Bps, variableBorrowApy: 300 as Bps, raw: null },
      ],
      getLendingPositions: async (_a: AccountHandle): Promise<LendingPosition[]> => [],
      supply: (ctx, i) => this.execute(ctx, { kind: "supply", protocolId: PROTOCOL_ID, chainId: ctx.account.chainId, input: i }),
      borrow: (ctx, i) => this.execute(ctx, { kind: "borrow", protocolId: PROTOCOL_ID, chainId: ctx.account.chainId, input: i }),
      repay: (ctx, i) => this.execute(ctx, { kind: "repay", protocolId: PROTOCOL_ID, chainId: ctx.account.chainId, input: i }),
      withdrawSupply: (ctx, i) => this.execute(ctx, { kind: "withdrawSupply", protocolId: PROTOCOL_ID, chainId: ctx.account.chainId, input: i }),
    };
  }
}
