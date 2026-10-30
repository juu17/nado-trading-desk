// Offline gate for the live composition root. Fakes for the gateway/signer/store prove the
// pre-audit fixes that are green offline but would be red live: owner lowercasing (#1), clock
// flooring (#2), write-bucket registration (#3), and the chainId single-source guard (#4).
import { describe, expect, it, vi } from "vitest";
import { InMemoryOperationsStore, RateLimiter, type ExperimentCampaign, type ExperimentPair, type ExperimentOrderRequest } from "@farm/core";
import type { MultiWalletNadoGateway, NadoGateway } from "@farm/adapter-nado";
import type { WalletSigner } from "@farm/adapter-api";
import { assembleLiveConnector, registerNadoWriteBuckets, canonicalOwner } from "./live-connector.js";

// A checksummed (mixed-case) address — exactly what a wative signer exposes, and what the
// coordinator would reject if compared against its lowercased owner() form.
const A_CHECKSUM = "0x01b3022F26AB8DAb66987453704613e4E2eFD9d1";
const B_CHECKSUM = "0x0451E360F508d1CA8b32d26e933E245349e302dA";

const signer = (addr: string): WalletSigner => ({
  address: { family: "evm", value: addr } as unknown as WalletSigner["address"],
  signTypedData: async () => ("0x" + "ab".repeat(32) + "1b") as `0x${string}`,
  signMessage: async () => "0x" as `0x${string}`,
  signBytes: async () => new Uint8Array(),
});

function fakeGateway(): { gw: MultiWalletNadoGateway; seen: string[] } {
  const seen: string[] = [];
  const view = {
    async getOrderBook() { return { market: "nado:perp:X", bids: [{ price: "100", size: "10" }], asks: [{ price: "101", size: "10" }], ts: 0, raw: null } as never; },
    async submitOrder() { return { digest: "0x" + "d".repeat(64), status: "open", raw: {} }; },
    async cancelOrders() { return { cancelled: [], raw: {} }; },
    async getPositions() { return []; }, async getOpenOrders() { return []; },
    async getMarkets() { return []; }, async getFills() { return []; }, async getBalances() { return []; },
  } as unknown as NadoGateway;
  return { gw: { forOwner: (o: string) => { seen.push(o); return view; }, owners: () => seen }, seen };
}

const deps = (over: Partial<Parameters<typeof assembleLiveConnector>[0]> = {}) => ({
  chainId: 763373, endpoint: "0x" + "9".repeat(40),
  gateway: fakeGateway().gw, signers: [signer(A_CHECKSUM), signer(B_CHECKSUM)],
  sizingFor: () => ({ tickSize: "1", stepSize: "0.001", minSize: "0.001", minNotional: "100" }),
  marketIdFor: () => "nado:perp:X", clock: () => 1_000_000_000_000,
  orderFill: (async () => undefined) as Parameters<typeof assembleLiveConnector>[0]["orderFill"],
  admit: () => {}, store: new InMemoryOperationsStore<ExperimentCampaign>(), ...over,
});

const campaign = (chainId = 763373): ExperimentCampaign => ({
  id: "c", chainId, mode: "LIVE", productId: 2, orderNotionalX18: "1000000000000000000000",
  targetNotionalPerWalletX18: "2000000000000000000000", slippageBps: 10, state: "RUNNING", epoch: 0,
  createdAt: 0, updatedAt: 0, activeGroup: 0, groups: [{ id: "g1", pairs: [pair()] }], wallets: {},
  rollovers: [], exitRequested: false } as unknown as ExperimentCampaign);
const pair = (): ExperimentPair => ({ id: "p1", a: canonicalOwner(A_CHECKSUM), b: canonicalOwner(B_CHECKSUM), state: "ACTIVE", rounds: [] });
const request = (over: Partial<ExperimentOrderRequest> = {}): ExperimentOrderRequest =>
  ({ id: "experiment:c:p1:1:A_OPEN:1", role: "A_OPEN", owner: canonicalOwner(A_CHECKSUM), side: "BUY", postOnly: true, reduceOnly: false, ...over });

describe("assembleLiveConnector — composition pre-audit fixes", () => {
  it("#1 canonicalises owners to lowercase; signerFor resolves by either casing", () => {
    const live = assembleLiveConnector(deps());
    expect(live.owners).toEqual([canonicalOwner(A_CHECKSUM), canonicalOwner(B_CHECKSUM)]);
    expect(live.owners.every((o) => o === o.toLowerCase())).toBe(true);
  });

  it("#1 forOwner is always called with the canonical (lowercase) owner the coordinator uses", async () => {
    const { gw, seen } = fakeGateway();
    const live = assembleLiveConnector(deps({ gateway: gw }));
    await live.connector.prepare(campaign(), pair(), request()); // prepare → forOwner(request.owner)
    expect(seen.every((o) => o === o.toLowerCase())).toBe(true);
    expect(seen).toContain(canonicalOwner(A_CHECKSUM));
  });

  it("#2 floors a fractional clock so the nonce mint's BigInt() never throws", async () => {
    const live = assembleLiveConnector(deps({ clock: () => 1_000_000_000_123.9 }));
    const prepared = await live.connector.prepare(campaign(), pair(), request());
    expect(Number.isInteger(prepared.expiration)).toBe(true);
    expect(() => BigInt(prepared.nonce)).not.toThrow();
  });

  it("#4 refuses to prepare when the campaign chainId diverges from the connector's (unsent)", async () => {
    const live = assembleLiveConnector(deps({ chainId: 763373 }));
    await expect(live.connector.prepare(campaign(57073), pair(), request())).rejects.toThrow("EXPERIMENT_CHAINID_MISMATCH");
  });

  it("throws for an unknown owner rather than signing with the wrong key", () => {
    const live = assembleLiveConnector(deps());
    // request for an owner with no signer in the cohort → resolved lazily in prepare/sign
    expect(() => assembleLiveConnector(deps({ signers: [] })).owners).not.toThrow();
    expect(live.owners).toHaveLength(2);
  });
});

describe("registerNadoWriteBuckets (#3) — order submits/cancels are metered, not unlimited", () => {
  it("registers nado:place and nado:rest on the shared limiter", () => {
    const limiter = new RateLimiter();
    expect(limiter.has("nado:place")).toBe(false);
    registerNadoWriteBuckets(limiter);
    expect(limiter.has("nado:place")).toBe(true);
    expect(limiter.has("nado:rest")).toBe(true);
  });

  it("honours operator-supplied rates and returns the same limiter (chainable)", () => {
    const limiter = new RateLimiter();
    const ret = registerNadoWriteBuckets(limiter, { placeCapacity: 10, placeWindowMs: 1000 });
    expect(ret).toBe(limiter);
    expect(limiter.has("nado:place")).toBe(true);
  });
});
