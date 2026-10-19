// =============================================================================
// Console composition root (offline). Wires the REAL NadoAdapter + core
// WativePlanRunner + WativeChainRegistry to a FAKE NadoGateway and a mock signer,
// so the drawer's actions exercise the actual engine (build EIP-712 → sign → submit)
// with mock data — no keys, no network, no testnet. apps/console is the only place
// allowed to import a concrete adapter.
// =============================================================================
import {
  WativeChainRegistry, defaultChainOverlay, WativePlanRunner, SerialNonceLane,
} from "@farm/core";
import type { OnchainExecutor } from "@farm/core";
import { NadoAdapter } from "@farm/adapter-nado";
import type { NadoGateway } from "@farm/adapter-nado";
import type {
  WalletSigner, SignerContext, PlaceOrderInput, CancelInput, Address, ChainId,
  Order, Market, Hex, Decimal, Bps, Operation,
} from "@farm/adapter-api";
import type { WalletVM } from "@farm/ui";
import { isLiveWallet } from "./live";
import { placeOrderLive, cancelLive } from "./liveContext";

const INK = 57073 as ChainId;

const PRODUCT_IDS: Record<string, number> = {
  "nado:perp:BTC-PERP": 2,
  "nado:perp:ETH-PERP": 4,
  "nado:spot:INK-USDT0": 6,
};

export const MARKETS: Market[] = [
  { id: "nado:perp:BTC-PERP", chainId: INK, product: "perp", base: "BTC", quote: "USDT0", tickSize: "0.1" as Decimal, stepSize: "0.001" as Decimal, minNotional: "10" as Decimal, makerFeeBps: -1 as Bps, takerFeeBps: 3 as Bps, maxLeverage: 20, raw: null },
  { id: "nado:perp:ETH-PERP", chainId: INK, product: "perp", base: "ETH", quote: "USDT0", tickSize: "0.01" as Decimal, stepSize: "0.01" as Decimal, minNotional: "10" as Decimal, makerFeeBps: -1 as Bps, takerFeeBps: 3 as Bps, maxLeverage: 20, raw: null },
  { id: "nado:spot:INK-USDT0", chainId: INK, product: "spot", base: "INK", quote: "USDT0", tickSize: "0.0001" as Decimal, stepSize: "1" as Decimal, minNotional: "5" as Decimal, makerFeeBps: 0 as Bps, takerFeeBps: 2 as Bps, raw: null },
];

// Deterministic fake digest from a string (no crypto needed for a mock).
function fakeDigest(seed: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return "0x" + h.toString(16).padStart(8, "0").repeat(8);
}

const fakeGateway: NadoGateway = {
  submitOrder: async (signed) => ({ digest: fakeDigest(signed.sender + String(signed.nonce)), status: "open", raw: signed }),
  cancelOrders: async (signed) => ({ cancelled: signed.digests.length ? signed.digests : [fakeDigest(signed.sender)], raw: signed }),
  getMarkets: async () => MARKETS,
  getOrderBook: async (market) => ({ market, bids: [], asks: [], ts: Date.now(), raw: null }),
  getPositions: async () => [],
  getOpenOrders: async () => [],
  getFills: async () => [],
  getBalances: async () => [],
};

// Mock signer: deterministic 65-byte signature; no key material in the offline console.
function mockSigner(address: Address): WalletSigner {
  const sig = ("0x" + "11".repeat(65)) as Hex;
  return {
    address,
    signTypedData: async () => sig,
    signDigest: async () => sig,
    signMessage: async () => sig,
    signBytes: async () => new Uint8Array(65),
  };
}

const registry = WativeChainRegistry.fromBuiltins(defaultChainOverlay());
const lane = new SerialNonceLane();
// Trading is protocol-execute (off-chain signed); the on-chain path is testnet-only.
const onchain: OnchainExecutor = { send: async () => { throw new Error("offline console: on-chain tx path is testnet-only"); } };
const runner = new WativePlanRunner(onchain);
const adapter = new NadoAdapter({ gateway: fakeGateway, productIds: PRODUCT_IDS });

function ctxFor(wallet: WalletVM): SignerContext {
  return {
    signer: mockSigner(wallet.address),
    account: { protocolId: "nado", chainId: INK, owner: wallet.address, subaccount: { id: "default", owner: wallet.address, label: "default", raw: null }, raw: null },
    chain: registry.require(INK),
    walletId: wallet.id,
    onchainNonces: lane,
    protocolNonces: { timestamp: () => BigInt(Date.now()), nextProtocolSeq: async () => 0 },
    runner,
  };
}

export async function placeOrder(wallet: WalletVM, input: PlaceOrderInput): Promise<Order> {
  if (isLiveWallet(wallet)) {
    // Live: sign IN-TAB → submit via the keyless relay (the adapter throws on rejection).
    return placeOrderLive(wallet.id, input.market, { side: input.side, size: input.size as string, price: input.price as string | undefined });
  }
  return adapter.trading.placeOrder(ctxFor(wallet), input);
}

export async function cancelOrders(wallet: WalletVM, input: CancelInput): Promise<{ cancelled: string[] }> {
  if (isLiveWallet(wallet)) {
    return cancelLive(wallet.id, input.market, input.venueIds?.[0]);
  }
  return adapter.trading.cancelOrders(ctxFor(wallet), input);
}

/** Dispatch a serializable Operation for one wallet. LIVE wallets (each an INDEPENDENT
 *  in-tab EOA) sign IN-TAB and go to the keyless relay under their own walletId, signed by
 *  THAT wallet's in-tab signer; every mock wallet runs the offline adapter. Throws on a
 *  live rejection so a sequencer margin/health/429 becomes a FAILED job (the scheduler's
 *  onJobFailed), never a silently-"done" one. */
export async function runOperation(wallet: WalletVM, op: Operation, opts?: { jobId?: string; signal?: AbortSignal }): Promise<unknown> {
  if (isLiveWallet(wallet)) {
    // Live ops sign IN-TAB → keyless relay; the adapter throws on a sequencer rejection,
    // so a margin/health/rate error becomes a FAILED job (never a silently-"done" one).
    if (op.kind === "placeOrder") {
      return placeOrderLive(wallet.id, op.input.market, { side: op.input.side, size: op.input.size as string, price: op.input.price as string | undefined, jobId: opts?.jobId, signal: opts?.signal });
    }
    if (op.kind === "cancel") {
      return cancelLive(wallet.id, op.input.market, op.input.venueIds?.[0], opts?.signal);
    }
    throw new Error(`live wallet supports placeOrder/cancel, not '${op.kind}'`);
  }
  const ctx = ctxFor(wallet);
  if (op.kind === "placeOrder") return adapter.trading.placeOrder(ctx, op.input);
  if (op.kind === "cancel") return adapter.trading.cancelOrders(ctx, op.input);
  throw new Error(`offline console supports placeOrder/cancel, not '${op.kind}'`);
}
