import { describe, it, expect, vi } from "vitest";
import { NadoAdapter } from "./adapter.js";
import type { NadoGateway } from "./gateway.js";
import type {
  SignerContext, WalletSigner, PlanRunner, ChainSpec, ChainId, Hex,
  PlaceOrderInput, OnChainNonceSource, ProtocolNonceSource, PlanResult, ExecutionPlan,
} from "@farm/adapter-api";

const signer: WalletSigner = {
  address: { family: "evm", value: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" },
  signTypedData: async () => "0xSIG" as Hex,
  signDigest: async () => "0xDIG" as Hex,
  signMessage: async () => "0xMSG" as Hex,
  signBytes: async () => new Uint8Array([1]),
};

// a minimal runner that signs the protocol-execute step and fires its submit
const runner: PlanRunner = {
  run: async (plan: ExecutionPlan, ctx: SignerContext): Promise<PlanResult> => {
    const stepResults: unknown[] = [];
    for (const step of plan.steps) {
      if (step.type === "protocol-execute") {
        const sig = await ctx.signer.signTypedData!(step.typedData!, step.chainId ?? 0);
        stepResults.push(await step.submit(sig));
      }
    }
    return { ok: true, stepResults, txHashes: [], raw: null };
  },
};

const chain: ChainSpec = {
  chainId: 57073, family: "evm", displayName: "Ink",
  nativeAsset: { symbol: "ETH", decimals: 18 },
  rpc: { read: [], broadcast: [] },
  broadcast: { singleAttempt: true, maxReattempts: 3, confirmations: 1, lookupBeforeRetry: true },
  rateLimits: [],
};
const onchainNonces: OnChainNonceSource = {
  lease: async () => ({ nonce: 0, commit: () => {}, release: () => {} }),
  peek: async () => 0, reconcile: () => {},
};
const protocolNonces: ProtocolNonceSource = { timestamp: () => 1n, nextProtocolSeq: async () => 0 };

function ctx(): SignerContext {
  return {
    signer,
    account: { protocolId: "nado", chainId: 57073 as ChainId, owner: signer.address, subaccount: { id: "default", owner: signer.address, label: "default", raw: null }, raw: null },
    chain, walletId: "w0", onchainNonces, protocolNonces, runner,
  };
}

function fakeGateway(over: Partial<NadoGateway> = {}): { gw: NadoGateway; captured: { order?: unknown; cancel?: unknown } } {
  const captured: { order?: unknown; cancel?: unknown } = {};
  const gw: NadoGateway = {
    submitOrder: async (signed) => { captured.order = signed; return { digest: "0xDIGEST", status: "open", raw: null }; },
    cancelOrders: async (signed) => { captured.cancel = signed; return { cancelled: ["0xDIGEST"], raw: null }; },
    getMarkets: async () => [],
    getOrderBook: async () => ({ market: "nado:perp:BTC-PERP", bids: [], asks: [], ts: 0, raw: null }),
    getPositions: async () => [],
    getOpenOrders: async () => [],
    getFills: async () => [],
    getBalances: async () => [],
    ...over,
  };
  return { gw, captured };
}

const PRODUCTS = { "nado:perp:BTC-PERP": 2 };

describe("NadoAdapter", () => {
  it("places an order: builds typed-data, signs, submits to the gateway, returns an Order", async () => {
    const { gw, captured } = fakeGateway();
    const adapter = new NadoAdapter({ gateway: gw, productIds: PRODUCTS });
    const input: PlaceOrderInput = { market: "nado:perp:BTC-PERP", side: "buy", kind: "limit", price: "63120" as PlaceOrderInput["price"], size: "0.1" as PlaceOrderInput["size"], postOnly: true, clientId: "c1" };
    const order = await adapter.trading.placeOrder(ctx(), input);
    expect(order.venueId).toBe("0xDIGEST");
    expect(order.status).toBe("open");
    expect(order.role).toBe("maker"); // postOnly
    expect((captured.order as { signature?: string }).signature).toBe("0xSIG");
    expect((captured.order as { typedData?: unknown }).typedData).toBeTruthy();
  });

  it("forwards hints.nonce/expiration (idempotency) into the built order so a retry is byte-identical", async () => {
    const { gw, captured } = fakeGateway();
    const adapter = new NadoAdapter({ gateway: gw, productIds: PRODUCTS });
    const input: PlaceOrderInput = { market: "nado:perp:BTC-PERP", side: "buy", kind: "limit", price: "63120" as PlaceOrderInput["price"], size: "0.1" as PlaceOrderInput["size"], postOnly: true, clientId: "c1", hints: { nonce: "777", expiration: "888" } };
    await adapter.trading.placeOrder(ctx(), input);
    const order = (captured.order as { order: { nonce: string; expiration: string } }).order;
    expect(order.nonce).toBe("777");       // the stable nonce, not a fresh getOrderNonce()
    expect(order.expiration).toBe("888");
    // without hints, each build gets a fresh (different) nonce
    const { gw: gw2, captured: c2 } = fakeGateway();
    const a2 = new NadoAdapter({ gateway: gw2, productIds: PRODUCTS });
    await a2.trading.placeOrder(ctx(), { ...input, hints: undefined });
    expect((c2.order as { order: { nonce: string } }).order.nonce).not.toBe("777");
  });

  it("cancels orders through the gateway", async () => {
    const { gw, captured } = fakeGateway();
    const adapter = new NadoAdapter({ gateway: gw, productIds: PRODUCTS });
    const res = await adapter.trading.cancelOrders(ctx(), { market: "nado:perp:BTC-PERP", venueIds: ["0x" + "11".repeat(32)] });
    expect(res.cancelled).toEqual(["0xDIGEST"]);
    expect((captured.cancel as { signature?: string }).signature).toBe("0xSIG");
  });

  it("declares support + capability + rate costs correctly", () => {
    const adapter = new NadoAdapter({ productIds: PRODUCTS });
    expect(adapter.supports("placeOrder")).toBe(true);
    expect(adapter.supports("supply")).toBe(false);
    expect(adapter.capability("trading")).toBe(adapter.trading);
    expect(adapter.capability("lending")).toBeUndefined();
    const cost = adapter.costOf({ kind: "placeOrder", postOnly: false });
    expect(cost.map((c) => c.bucket)).toContain("nado:place");
    expect(cost.map((c) => c.bucket)).toContain("nado:rest");
    expect(adapter.labelOperation({ kind: "cancel", protocolId: "nado", chainId: 57073, input: {} }).destructive).toBe(true);
  });

  it("errors clearly when the gateway is not wired (testnet-gated live surface)", async () => {
    const adapter = new NadoAdapter({ productIds: PRODUCTS });
    await expect(adapter.getBalances({ chainId: 57073 as ChainId, owner: signer.address, raw: null })).rejects.toMatchObject({ category: "network" });
  });

  it("rejects an unknown market", async () => {
    const { gw } = fakeGateway();
    const adapter = new NadoAdapter({ gateway: gw });
    const spy = vi.fn();
    await adapter.trading.placeOrder(ctx(), { market: "nado:perp:UNKNOWN", side: "buy", kind: "limit", price: "1" as PlaceOrderInput["price"], size: "1" as PlaceOrderInput["size"], clientId: "x" }).catch(spy);
    expect(spy).toHaveBeenCalled();
  });
});
