// Offline gate for the live A-5 OrderFillSource composition. Fake Nado reads drive every
// hardened contract the A-5 pre-audit flagged (#4–#9) — the ones that are green offline but
// would be red live if wrong.
import { describe, expect, it } from "vitest";
import type { NadoFillReads, RestingOrderResult, CumulativeFill } from "@farm/adapter-nado";
import { createLiveOrderFillSource } from "./live-order-fill.js";

const E18 = 10n ** 18n;
const x18 = (n: number): string => (BigInt(n) * E18).toString();

function reads(over: {
  resting?: RestingOrderResult;
  fills?: CumulativeFill;
  net?: string;
}): NadoFillReads {
  return {
    restingOrder: async () => over.resting ?? { kind: "not-found" },
    cumulativeFills: async () => over.fills,
    netPositionX18: async () => over.net ?? "0",
  };
}

const fills = (b: number, q: number, f: number): CumulativeFill =>
  ({ baseFilledX18: x18(b), quoteFilledX18: x18(q), feePaidX18: x18(f) });

describe("createLiveOrderFillSource — A-5 authoritative per-order fill", () => {
  it("#9 resting maker reports raw-X18 filled (total−unfilled), resting:true, not terminal", async () => {
    const src = createLiveOrderFillSource(reads({ resting: { kind: "resting", totalAmountX18: x18(10), unfilledAmountX18: x18(4) }, fills: fills(6, 600, 1) }));
    const r = await src("0xA", 2, "0xd");
    expect(r).toEqual({ filledX18: x18(6), quoteFilledX18: x18(600), feePaidX18: x18(1), terminal: false, resting: true });
  });

  it("resting maker with no fill frame yet → partial accounting 0, still resting (monotonic)", async () => {
    const src = createLiveOrderFillSource(reads({ resting: { kind: "resting", totalAmountX18: x18(10), unfilledAmountX18: x18(10) } }));
    expect(await src("0xA", 2, "0xd")).toEqual({ filledX18: "0", quoteFilledX18: "0", feePaidX18: "0", terminal: false, resting: true });
  });

  it("#6 a fully-filled maker the engine still echoes (unfilled==0) WITH accounting → terminal", async () => {
    const src = createLiveOrderFillSource(reads({ resting: { kind: "resting", totalAmountX18: x18(10), unfilledAmountX18: x18(0) }, fills: fills(10, 1000, 2) }));
    expect(await src("0xA", 2, "0xd")).toEqual({ filledX18: x18(10), quoteFilledX18: x18(1000), feePaidX18: x18(2), terminal: true, resting: false });
  });

  it("#7 a fully-filled maker whose accounting hasn't landed is NOT declared terminal (no frozen-0)", async () => {
    const src = createLiveOrderFillSource(reads({ resting: { kind: "resting", totalAmountX18: x18(10), unfilledAmountX18: x18(0) } /* no fills */ }));
    const r = await src("0xA", 2, "0xd");
    expect(r).toMatchObject({ terminal: false, resting: false, filledX18: x18(10) });
  });

  it("taker IOC (not-found) WITH confirmed fills → terminal, accounting from the stream", async () => {
    const src = createLiveOrderFillSource(reads({ resting: { kind: "not-found" }, fills: fills(10, 1000, 3) }));
    expect(await src("0xB", 2, "0xd")).toEqual({ filledX18: x18(10), quoteFilledX18: x18(1000), feePaidX18: x18(3), terminal: true, resting: false });
  });

  it("#4/#5 a gone order with NO confirmed fill yet → undefined (lag), NEVER {filled:0,terminal:true}", async () => {
    const src = createLiveOrderFillSource(reads({ resting: { kind: "not-found" } /* no fills */ }));
    expect(await src("0xB", 2, "0xd")).toBeUndefined();
  });

  it("#8 a transport/WAF read failure (unavailable) → undefined, NEVER terminal", async () => {
    const src = createLiveOrderFillSource(reads({ resting: { kind: "unavailable" }, fills: fills(10, 1000, 3) }));
    expect(await src("0xB", 2, "0xd")).toBeUndefined();
  });
});
