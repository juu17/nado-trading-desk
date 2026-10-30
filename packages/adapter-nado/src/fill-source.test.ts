// Offline gate for the Nado fill-source reads behind A-5. No network: a fake engine, a hand-fed
// accumulator, and a fake socket prove the unit math (X18 quote, clamped fee), the resting/
// not-found/unavailable discrimination, position summation, and the keyless `fill` subscribe.
import { describe, expect, it, vi } from "vitest";
import {
  FillAccumulator, createNadoFillReads, subscribeFills,
  type NadoFillFrame, type EngineOrderQueryLike, type SocketLike,
} from "./fill-source.js";

const E18 = 10n ** 18n;
const x18 = (n: number | bigint): string => (BigInt(n) * E18).toString();
const bn = (v: string) => ({ toFixed: (_dp?: number) => v }); // BigNumberish stub

const frame = (over: Partial<NadoFillFrame> = {}): NadoFillFrame => ({
  product_id: 2, subaccount: "0xsenderA", order_digest: "0xdig",
  filled_qty: x18(10), remaining_qty: x18(0), original_qty: x18(10),
  price: x18(100), is_taker: true, fee: (5n * E18 / 100n).toString() /* 0.05e18 */, submission_idx: "1", ...over,
});

describe("FillAccumulator — unit-correct, monotonic cumulative by digest", () => {
  it("a single full taker fill → base, X18 quote (filled×price/1e18), fee", () => {
    const acc = new FillAccumulator();
    acc.ingest(frame());
    const f = acc.get("0xdig")!;
    expect(f.baseFilledX18).toBe(x18(10));              // original − remaining
    expect(f.quoteFilledX18).toBe((10n * E18 * (100n * E18) / E18).toString()); // 10×100 = 1000 (X18)
    expect(f.quoteFilledX18).toBe(x18(1000));
    expect(f.feePaidX18).toBe((5n * E18 / 100n).toString());
  });

  it("multi-level partials weight quote by each fill's own price; base = original−remaining", () => {
    const acc = new FillAccumulator();
    // fill 1: 4 @ 100 ; fill 2: remaining 6 @ 110
    acc.ingest(frame({ remaining_qty: x18(6), price: x18(100), fee: x18(0), submission_idx: "1" }));
    acc.ingest(frame({ remaining_qty: x18(0), price: x18(110), fee: x18(0), submission_idx: "2" }));
    const f = acc.get("0xdig")!;
    expect(f.baseFilledX18).toBe(x18(10));
    // 4×100 + 6×110 = 400 + 660 = 1060
    expect(f.quoteFilledX18).toBe(x18(1060));
  });

  it("is robust to out-of-order arrival and redelivery (sort + dedup by submission_idx)", () => {
    const acc = new FillAccumulator();
    acc.ingest(frame({ remaining_qty: x18(0), price: x18(110), fee: x18(0), submission_idx: "2" })); // later first
    acc.ingest(frame({ remaining_qty: x18(6), price: x18(100), fee: x18(0), submission_idx: "1" }));
    acc.ingest(frame({ remaining_qty: x18(6), price: x18(100), fee: x18(0), submission_idx: "1" })); // redelivery
    const f = acc.get("0xdig")!;
    expect(f.baseFilledX18).toBe(x18(10));
    expect(f.quoteFilledX18).toBe(x18(1060));
  });

  it("clamps a maker REBATE (negative fee) to zero cost — never negative/decreasing", () => {
    const acc = new FillAccumulator();
    acc.ingest(frame({ is_taker: false, fee: (-1n * E18 / 100n).toString(), submission_idx: "1" }));
    const f = acc.get("0xdig")!;
    expect(f.feePaidX18).toBe("0"); // rebate → 0, not negative
  });

  it("returns undefined for a digest with no frames (not zero)", () => {
    expect(new FillAccumulator().get("0xnope")).toBeUndefined();
  });
});

describe("createNadoFillReads — resting / not-found / unavailable discrimination", () => {
  const makeEngine = (over: Partial<EngineOrderQueryLike> = {}): EngineOrderQueryLike => ({
    getOrder: vi.fn(async () => ({ totalAmount: bn(x18(10)), unfilledAmount: bn(x18(4)) })),
    getSubaccountSummary: vi.fn(async () => ({ balances: [{ productId: 2, amount: bn(x18(6)) }] })),
    ...over,
  });

  it("maps a live order to resting raw X18 total/unfilled", async () => {
    const reads = createNadoFillReads({ engine: makeEngine(), accumulator: new FillAccumulator() });
    const r = await reads.restingOrder("0xA", 2, "0xdig");
    expect(r).toEqual({ kind: "resting", totalAmountX18: x18(10), unfilledAmountX18: x18(4) });
  });

  it("a null getOrder → not-found (gone from the book)", async () => {
    const reads = createNadoFillReads({ engine: makeEngine({ getOrder: async () => null }), accumulator: new FillAccumulator() });
    expect(await reads.restingOrder("0xA", 2, "0xdig")).toEqual({ kind: "not-found" });
  });

  it("a structured not-found rejection → not-found; a transport/WAF failure → unavailable (never 'gone')", async () => {
    const notFound = createNadoFillReads({ engine: makeEngine({ getOrder: async () => { throw new Error("order not found"); } }), accumulator: new FillAccumulator() });
    expect(await notFound.restingOrder("0xA", 2, "0xdig")).toEqual({ kind: "not-found" });
    const waf = createNadoFillReads({ engine: makeEngine({ getOrder: async () => { throw Object.assign(new Error("HTTP 403"), { code: "403" }); } }), accumulator: new FillAccumulator() });
    expect(await waf.restingOrder("0xA", 2, "0xdig")).toEqual({ kind: "unavailable" });
    const reset = createNadoFillReads({ engine: makeEngine({ getOrder: async () => { throw new Error("socket ECONNRESET"); } }), accumulator: new FillAccumulator() });
    expect(await reset.restingOrder("0xA", 2, "0xdig")).toEqual({ kind: "unavailable" });
  });

  it("sums the fresh net position for a product (signed X18)", async () => {
    const reads = createNadoFillReads({ engine: makeEngine({ getSubaccountSummary: async () => ({ balances: [{ productId: 2, amount: bn("-" + x18(3)) }, { productId: 99, amount: bn(x18(5)) }] }) }), accumulator: new FillAccumulator() });
    expect(await reads.netPositionX18("0xA", 2)).toBe("-" + x18(3));
  });

  it("gates reads through the injected (urgent) read budget", async () => {
    const acquire = vi.fn(async () => {});
    const reads = createNadoFillReads({ engine: makeEngine(), accumulator: new FillAccumulator(), acquire });
    await reads.restingOrder("0xA", 2, "0xdig");
    await reads.netPositionX18("0xA", 2);
    expect(acquire).toHaveBeenCalledWith(true); // fill-critical → urgent
  });
});

describe("subscribeFills — keyless public `fill` subscription feeds the accumulator", () => {
  function fakeSocket() {
    const listeners: Record<string, Array<(ev: { data?: unknown }) => void>> = {};
    const sent: unknown[] = [];
    const socket: SocketLike = {
      send: (d) => sent.push(JSON.parse(d)),
      addEventListener: (t, l) => { (listeners[t] ??= []).push(l); },
    };
    return { socket, sent, emit: (t: string, data: unknown) => (listeners[t] ?? []).forEach((l) => l({ data })) };
  }

  it("subscribes type:'fill' per subaccount on open (no auth frame) and ingests fill frames", () => {
    const { socket, sent, emit } = fakeSocket();
    const acc = new FillAccumulator();
    const wakes: string[] = [];
    subscribeFills(socket, ["0xsenderA", "0xsenderB"], acc, { onWake: (d) => wakes.push(d) });
    emit("open", undefined);
    expect(sent).toHaveLength(2);
    expect(sent.every((m) => (m as { method: string }).method === "subscribe")).toBe(true);
    expect((sent[0] as { stream: { type: string } }).stream.type).toBe("fill");
    expect(sent.some((m) => (m as { method: string }).method === "authenticate")).toBe(false); // keyless

    emit("message", JSON.stringify({ type: "fill", ...frame() }));
    expect(acc.get("0xdig")?.baseFilledX18).toBe(x18(10));
    expect(wakes).toEqual(["0xdig"]);

    emit("message", JSON.stringify({ type: "best_bid_offer", product_id: 2 })); // non-fill ignored
    expect(wakes).toEqual(["0xdig"]);
  });

  it("the disposer stops further ingestion", () => {
    const { socket, emit } = fakeSocket();
    const acc = new FillAccumulator();
    const dispose = subscribeFills(socket, ["0xsenderA"], acc);
    emit("open", undefined);
    dispose();
    emit("message", JSON.stringify({ type: "fill", ...frame() }));
    expect(acc.get("0xdig")).toBeUndefined();
  });
});
