import { describe, it, expect } from "vitest";
import { createLiveNadoGateway } from "./live-gateway.js";
import type { TransportLike, LimiterLike } from "./live-gateway.js";
import type { BuiltOrder } from "./execute.js";
import type { Hex } from "@farm/adapter-api";

// Wave A hardening: a failed write must become a THROWN failure (a FAILED job), never a
// silent {digest:"",status:"open"} success. Two guards cover that — the client transport
// throws on a non-2xx relay response, and assertOk throws on a 2xx body that carries an
// error but no status (the relay's own 502 {error} envelope). These tests pin both.
const limiter: LimiterLike = { acquire: async () => {} };

function gatewayWith(transport: TransportLike) {
  // The SDK sync payload builders are pure here; the transport mock returns the envelope.
  const engine = {
    payloadBuilder: {
      buildPlaceOrderPayloadSync: () => ({ payload: { place_order: "x" } }),
      buildCancelOrdersPayloadSync: () => ({ cancel_orders: "x" }),
    },
  } as never;
  return createLiveNadoGateway({
    engine, transport, limiter, engineUrl: "/relay", chainId: 763373,
    endpoint: "0x698D87105274292B5673367DEC81874Ce3633Ac2",
    owner: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    markets: [], productIds: { "nado:perp:BTC-PERP": 2 },
  });
}

const signedOrder = {
  productId: 2, order: {}, sender: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  signature: ("0x" + "11".repeat(65)) as Hex,
} as unknown as BuiltOrder & { signature: Hex };

const transportReturning = (res: unknown): TransportLike => ({ request: async () => res as never });

describe("createLiveNadoGateway — write-path failure handling (Wave A)", () => {
  it("returns the digest on a success envelope", async () => {
    const gw = gatewayWith(transportReturning({ status: "success", data: { digest: "0xDEAD" } }));
    const r = await gw.submitOrder(signedOrder);
    expect(r.digest).toBe("0xDEAD");
    expect(r.status).toBe("open");
  });

  it("throws on a sequencer failure envelope (status:failure)", async () => {
    const gw = gatewayWith(transportReturning({ status: "failure", error: "price band", error_code: 2007 }));
    await expect(gw.submitOrder(signedOrder)).rejects.toMatchObject({ category: "rejected" });
  });

  it("throws on an error-without-status envelope (relay 502 shape) — no silent false success", async () => {
    const gw = gatewayWith(transportReturning({ error: "sequencer unreachable" }));
    await expect(gw.submitOrder(signedOrder)).rejects.toMatchObject({ category: "network" });
  });

  it("does NOT false-positive on error:null / error:'' with no status", async () => {
    const gwNull = gatewayWith(transportReturning({ error: null, data: { digest: "0xBEEF" } }));
    await expect(gwNull.submitOrder(signedOrder)).resolves.toMatchObject({ digest: "0xBEEF" });
    const gwEmpty = gatewayWith(transportReturning({ error: "", data: { digest: "0xBEEF" } }));
    await expect(gwEmpty.submitOrder(signedOrder)).resolves.toMatchObject({ digest: "0xBEEF" });
  });

  it("propagates a transport throw (non-2xx relay) as a rejected submit, not a silent success", async () => {
    const throwing: TransportLike = { request: async () => { throw new Error("relay 502: boom"); } };
    const gw = gatewayWith(throwing);
    await expect(gw.submitOrder(signedOrder)).rejects.toThrow(/relay 502/);
  });
});

// Wave 1b: getOrderBook is backed by the SDK getMarketLiquidity query (price is HUMAN, size is X18).
describe("createLiveNadoGateway — getOrderBook (Wave 1b)", () => {
  const bn = (v: string) => ({ toFixed: (_dp?: number) => v }); // minimal BigNumber-like
  function gatewayWithEngine(engine: unknown) {
    return createLiveNadoGateway({
      engine: engine as never, transport: transportReturning({}), limiter, engineUrl: "/relay",
      chainId: 763373, endpoint: "0x698D87105274292B5673367DEC81874Ce3633Ac2",
      owner: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      markets: [], productIds: { "nado:perp:BTC-PERP": 2 },
    });
  }

  it("maps bids/asks (price passes through, size converts X18 -> human)", async () => {
    const gw = gatewayWithEngine({
      payloadBuilder: {},
      getMarketLiquidity: async () => ({
        bids: [{ price: bn("995"), liquidity: bn("2000000000000000000") }],
        asks: [{ price: bn("1005"), liquidity: bn("3000000000000000000") }],
      }),
    });
    const book = await gw.getOrderBook("nado:perp:BTC-PERP" as never, 5);
    expect(book.market).toBe("nado:perp:BTC-PERP");
    expect(book.bids).toEqual([{ price: "995", size: "2" }]);
    expect(book.asks).toEqual([{ price: "1005", size: "3" }]);
  });

  it("returns an empty book for an unknown market without calling the sequencer", async () => {
    let called = false;
    const gw = gatewayWithEngine({ payloadBuilder: {}, getMarketLiquidity: async () => { called = true; return { bids: [], asks: [] }; } });
    const book = await gw.getOrderBook("nado:perp:NOPE" as never);
    expect(book.bids).toEqual([]);
    expect(book.asks).toEqual([]);
    expect(called).toBe(false);
  });
});
