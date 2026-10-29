import { describe, it, expect } from "vitest";
import { createMultiWalletNadoGateway } from "./multi-wallet-gateway.js";
import type { MultiWalletNadoGatewayDeps } from "./multi-wallet-gateway.js";
import type { TransportLike, LimiterLike } from "./live-gateway.js";
import type { MarketId } from "@farm/adapter-api";

const A = "0xaaaa000000000000000000000000000000000001";
const B = "0xbbbb000000000000000000000000000000000002";

function harness() {
  const reads: string[] = []; // captured subaccountOwner per read
  let acquires = 0;
  const limiter: LimiterLike = { acquire: async () => { acquires++; } };
  const transport: TransportLike = { request: async () => ({ status: "success" }) as never };
  const engine = {
    payloadBuilder: {
      buildPlaceOrderPayloadSync: () => ({ payload: {} }),
      buildCancelOrdersPayloadSync: () => ({}),
    },
    getSubaccountMultiProductOrders: async (q: { subaccountOwner: string }) => {
      reads.push(q.subaccountOwner);
      return { productOrders: [] };
    },
  } as never;
  const shared: MultiWalletNadoGatewayDeps = {
    engine, transport, limiter, engineUrl: "/relay", chainId: 763373,
    endpoint: "0x698D87105274292B5673367DEC81874Ce3633Ac2",
    markets: [], productIds: { "nado:perp:BTC-PERP": 2 } as Record<MarketId, number>,
  };
  return {
    gw: createMultiWalletNadoGateway(shared),
    reads,
    get acquires() { return acquires; },
  };
}

describe("createMultiWalletNadoGateway", () => {
  it("memoizes one view per owner (same ref), distinct across owners", () => {
    const { gw } = harness();
    const a1 = gw.forOwner(A);
    const a2 = gw.forOwner(A);
    const b = gw.forOwner(B);
    expect(a1).toBe(a2); // memoized
    expect(a1).not.toBe(b); // distinct wallets, distinct views
    expect(gw.owners().sort()).toEqual([A, B].map((o) => o.toLowerCase()).sort());
  });

  it("folds case when memoizing (one wallet, one view)", () => {
    const { gw } = harness();
    const lower = gw.forOwner(A.toLowerCase());
    const upper = gw.forOwner(A.toUpperCase());
    expect(lower).toBe(upper);
    expect(gw.owners()).toHaveLength(1);
  });

  it("each view reads with ITS OWN owner, over the shared limiter", async () => {
    const h = harness();
    await h.gw.forOwner(A).getOpenOrders("default");
    await h.gw.forOwner(B).getOpenOrders("default");
    expect(h.reads).toEqual([A, B]); // each view bound its own owner
    expect(h.acquires).toBe(2); // both reads gated on the one shared limiter
  });

  it("passes the owner through UN-MANGLED to reads (first-casing-wins, not the folded key)", async () => {
    const h = harness();
    const mixed = "0xAbCd000000000000000000000000000000000003";
    await h.gw.forOwner(mixed).getOpenOrders("default");
    // the read must use the ORIGINAL casing, not mixed.toLowerCase()
    expect(h.reads).toEqual([mixed]);
    // a later call in different casing reuses the SAME view (folded key) → still the
    // first casing on reads, never the second
    await h.gw.forOwner(mixed.toLowerCase()).getOpenOrders("default");
    expect(h.reads).toEqual([mixed, mixed]);
    expect(h.gw.owners()).toEqual([mixed.toLowerCase()]);
  });
});
