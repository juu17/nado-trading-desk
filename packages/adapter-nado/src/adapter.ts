// =============================================================================
// @farm/adapter-nado · the NadoAdapter — a ProtocolAdapter (universal port +
// trading capability). It builds EIP-712 executes, hands them to the core plan
// runner to sign (via the seam WalletSigner, wative-backed), and submits the
// signed payload through the NadoGateway. It never touches key material, RPC, or
// the chain directly — chain-level funding rides core/chain; off-chain trading
// rides the gateway.
// =============================================================================
import type {
  ProtocolAdapter, ProtocolManifest, AdapterEnv, AdapterOp, RateCost, Address,
  ChainId, WalletId, AccountHandle, Balance, DataKind, StreamSink, Subscription,
  OperationKind, SignerContext, SignedPayloadPreview, ProtocolOperation, Operation,
  OpResultOf, AdapterError, SafetyLabel, CapabilityId, CapabilityMap,
  TradingCapability, MarketId, Market, Order,
  PlaceOrderInput, CancelInput, ReplaceInput, NormalizedOrder, ExecutionPlan,
  Subaccount, Hex,
} from "@farm/adapter-api";
import { NADO_MANIFEST } from "./manifest.js";
import { buildPlaceOrderTypedData, buildCancelTypedData } from "./execute.js";
import { validateOrder } from "./validate.js";
import type { NadoGateway } from "./gateway.js";

export interface NadoAdapterOpts {
  /** Injected for tests / custom transports; init() builds the live one otherwise. */
  gateway?: NadoGateway;
  /** MarketId → Nado numeric product id. (Live markets come from the gateway.) */
  productIds?: Readonly<Record<MarketId, number>>;
  /** Nado Endpoint address — the cancel EIP-712 domain's verifyingContract. Required
   *  for LIVE cancels (the sequencer reconstructs the domain with it); absent offline. */
  endpoint?: string;
}

function adapterError(message: string, category: AdapterError["category"] = "rejected", raw?: unknown): AdapterError {
  return { category, retrySafe: category === "retryable-safe", message, raw: raw ?? null };
}

export class NadoAdapter implements ProtocolAdapter {
  readonly manifest: ProtocolManifest = NADO_MANIFEST;
  readonly trading: TradingCapability;

  private _env?: AdapterEnv;
  private _gateway?: NadoGateway;
  private readonly productIds: Record<MarketId, number>;
  private readonly endpoint?: string;

  constructor(opts: NadoAdapterOpts = {}) {
    this._gateway = opts.gateway;
    this.productIds = { ...opts.productIds };
    this.endpoint = opts.endpoint;
    this.trading = this.makeTrading();
  }

  async init(env: AdapterEnv): Promise<void> {
    this._env = env;
    // The live HTTP/WS NadoGateway (over env.request / env.openSocket against the
    // real Nado endpoints) is wired + verified at the testnet gate. Until then an
    // injected gateway (tests / custom transport) is used.
    if (!this._gateway) env.logger.warn("NadoAdapter.init: no live gateway wired yet (testnet); inject one for offline use");
  }
  async dispose(): Promise<void> { this._env = undefined; }

  private gateway(): NadoGateway {
    if (!this._gateway) throw adapterError("Nado gateway not wired (live sequencer client is testnet-gated)", "network");
    return this._gateway;
  }

  private productIdFor(market: MarketId): number {
    const id = this.productIds[market];
    if (id === undefined) throw adapterError(`unknown Nado market '${market}' (no product id)`, "rejected");
    return id;
  }
  private subName(input?: { subaccount?: Subaccount }, ctx?: SignerContext): string {
    return input?.subaccount?.label ?? ctx?.account.subaccount?.label ?? "default";
  }
  private owner(ctx: SignerContext): string { return ctx.signer.address.value; }

  // ---- universal port -------------------------------------------------------
  costOf(op: AdapterOp): RateCost[] {
    switch (op.kind) {
      case "placeOrder":
      case "replaceOrders":
        return [{ bucket: "nado:place", scope: "subaccount", weight: 1 }, { bucket: "nado:rest", scope: "ip", weight: 1 }];
      case "cancelOrders":
      case "deposit":
      case "withdraw":
      case "linkSigner":
      case "query":
        return [{ bucket: "nado:rest", scope: "ip", weight: 1 }];
      default:
        return [];
    }
  }

  async resolveAccount(a: { owner: Address; chainId: ChainId; walletId?: WalletId; subaccountName?: string }): Promise<AccountHandle> {
    const subaccount: Subaccount = { id: a.subaccountName ?? "default", owner: a.owner, label: a.subaccountName ?? "default", raw: null };
    return { protocolId: "nado", chainId: a.chainId, owner: a.owner, walletId: a.walletId, subaccount, readiness: "unfunded", raw: null };
  }

  async getBalances(a: AccountHandle): Promise<Balance[]> {
    return this.gateway().getBalances(a.subaccount?.label ?? "default");
  }

  subscribe(_targets: AccountHandle[], _kinds: DataKind[], _sink: StreamSink): Subscription {
    // The WS multiplexer is part of the live gateway (testnet). Return an inert
    // subscription so callers can wire the surface before the stream exists.
    return { addTargets: () => {}, removeTargets: () => {}, close: () => {} };
  }

  supports(op: OperationKind): boolean {
    return this.manifest.supportedOps.includes(op);
  }

  async preview(ctx: SignerContext, op: ProtocolOperation): Promise<SignedPayloadPreview> {
    const label = this.labelOperation(op);
    let summary: string;
    if (op.kind === "placeOrder") {
      const i = op.input;
      summary = `place ${i.side} ${i.size as string}${i.price ? " @ " + (i.price as string) : " (market)"} on ${i.market}`;
    } else if (op.kind === "cancel") {
      summary = `cancel ${op.input.venueIds?.length ?? op.input.clientIds?.length ?? 0} order(s)` + (op.input.market ? ` on ${op.input.market}` : "");
    } else {
      summary = `${op.kind} on Nado`;
    }
    return {
      summary, signedKind: "eip712", chainId: op.chainId, method: op.kind,
      label, warnings: [], decodedByCore: false, raw: op, // adapter-asserted (trust-asymmetry)
    };
  }

  async execute<O extends ProtocolOperation>(ctx: SignerContext, op: O): Promise<OpResultOf<O>> {
    if (op.kind === "placeOrder") return (await this.doPlaceOrder(ctx, op.chainId, op.input)) as OpResultOf<O>;
    if (op.kind === "cancel") return (await this.doCancel(ctx, op.chainId, op.input)) as OpResultOf<O>;
    if (op.kind === "replace") {
      await this.doCancel(ctx, op.chainId, op.input.cancel);
      return (await this.doPlaceOrder(ctx, op.chainId, op.input.place)) as OpResultOf<O>;
    }
    throw adapterError(`Nado does not support op '${op.kind}'`, "rejected");
  }

  private async doPlaceOrder(ctx: SignerContext, chainId: ChainId, input: PlaceOrderInput): Promise<Order> {
    const built = buildPlaceOrderTypedData(input, {
      chainId: Number(chainId), productId: this.productIdFor(input.market),
      ownerAddress: this.owner(ctx), subaccountName: this.subName(input, ctx),
      // Idempotency hints (optional): a stable nonce+expiration makes a retry byte-identical.
      nonce: input.hints?.nonce != null ? BigInt(input.hints.nonce) : undefined,
      expiration: input.hints?.expiration != null ? BigInt(input.hints.expiration) : undefined,
    });
    const op: ProtocolOperation = { kind: "placeOrder", protocolId: "nado", chainId, input };
    let order: Order | undefined;
    const plan: ExecutionPlan = {
      describe: `nado place ${input.side} ${input.market}`,
      steps: [{
        type: "protocol-execute", typedData: built.typedData, chainId: Number(chainId),
        bucket: "nado:place", weight: 1,
        preview: await this.preview(ctx, op), safety: this.labelOperation(op),
        submit: async (sig: Hex | Uint8Array) => {
          const r = await this.gateway().submitOrder({ ...built, signature: sig });
          order = this.toOrder(input, r.digest, r.status, r.raw);
          return r;
        },
      }],
    };
    const res = await ctx.runner.run(plan, ctx);
    if (!res.ok || !order) throw this.normalizeError(res.raw);
    return order;
  }

  private async doCancel(ctx: SignerContext, chainId: ChainId, input: CancelInput): Promise<{ cancelled: string[] }> {
    const productIds = input.market ? [this.productIdFor(input.market)] : [];
    const built = buildCancelTypedData(input, {
      chainId: Number(chainId), ownerAddress: this.owner(ctx), subaccountName: this.subName(input, ctx),
      verifyingContract: this.endpoint, // LIVE: the sequencer's cancel domain uses the Endpoint addr
    }, productIds);
    const op: ProtocolOperation = { kind: "cancel", protocolId: "nado", chainId, input };
    let cancelled: string[] | undefined;
    const plan: ExecutionPlan = {
      describe: `nado cancel ${input.market ?? "orders"}`,
      steps: [{
        type: "protocol-execute", typedData: built.typedData, chainId: Number(chainId),
        bucket: "nado:rest", weight: 1,
        preview: await this.preview(ctx, op), safety: this.labelOperation(op),
        submit: async (sig: Hex | Uint8Array) => {
          const r = await this.gateway().cancelOrders({ ...built, signature: sig });
          cancelled = r.cancelled;
          return r;
        },
      }],
    };
    const res = await ctx.runner.run(plan, ctx);
    if (!res.ok || !cancelled) throw this.normalizeError(res.raw);
    return { cancelled };
  }

  private toOrder(input: PlaceOrderInput, venueId: string, status: string, raw: unknown): Order {
    const now = Date.now();
    const role = input.postOnly ? "maker" : input.kind === "market" ? "taker" : "unknown";
    return {
      clientId: input.clientId, venueId, market: input.market, subaccount: input.subaccount,
      side: input.side, kind: input.kind, role, price: input.price, size: input.size,
      filled: "0" as Order["filled"], remaining: input.size, tif: input.tif,
      postOnly: input.postOnly ?? false, reduceOnly: input.reduceOnly ?? false,
      status: status === "filled" ? "filled" : "open", createdMs: now, updatedMs: now, raw,
    };
  }

  normalizeError(e: unknown): AdapterError {
    if (e && typeof e === "object" && "category" in e) return e as AdapterError;
    return adapterError(e instanceof Error ? e.message : String(e), "rejected", e);
  }

  labelOperation(op: Operation): SafetyLabel {
    const base: SafetyLabel = { destructive: false, grantsStandingAuth: false, movesFunds: false, requiresPrimaryKey: false, blastRadiusClass: "trading" };
    if (op.kind === "cancel" || op.kind === "replace") return { ...base, destructive: true };
    return base;
  }

  capability<K extends CapabilityId>(id: K): CapabilityMap[K] | undefined {
    return id === "trading" ? (this.trading as CapabilityMap[K]) : undefined;
  }

  // ---- trading capability ---------------------------------------------------
  private makeTrading(): TradingCapability {
    return {
      getMarkets: () => this.gateway().getMarkets(),
      getOrderBook: (m, depth) => this.gateway().getOrderBook(m, depth),
      getPositions: (a) => this.gateway().getPositions(a.subaccount?.label ?? "default"),
      getOpenOrders: (a) => this.gateway().getOpenOrders(a.subaccount?.label ?? "default"),
      getFills: (a, since) => this.gateway().getFills(a.subaccount?.label ?? "default", since),
      normalizeOrder: (i, m) => this.normalizeOrder(i, m),
      placeOrder: (ctx, i) => this.doPlaceOrder(ctx, ctx.account.chainId, i),
      cancelOrders: (ctx, c) => this.doCancel(ctx, ctx.account.chainId, c),
      replaceOrder: async (ctx, r: ReplaceInput) => {
        await this.doCancel(ctx, ctx.account.chainId, r.cancel);
        return this.doPlaceOrder(ctx, ctx.account.chainId, r.place);
      },
    };
  }

  /** Input hygiene (M10): round to the market's tick/step + min-notional check, then
   *  resolve the final maker/taker role. No strategy/EV — rounding + role only. */
  private normalizeOrder(i: PlaceOrderInput, m: Market): NormalizedOrder {
    const { normalized } = validateOrder(i, m);
    const role = normalized.postOnly ? "maker" : normalized.kind === "market" || normalized.tif === "ioc" ? "taker" : "unknown";
    return { input: normalized, role };
  }
}
