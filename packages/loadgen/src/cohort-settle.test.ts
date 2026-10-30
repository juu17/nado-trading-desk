// Guards the between-rounds flat+settled gate (A-6 / decision #3): a reused cohort must be
// proven flat (zero position + zero open orders, + Phase-C recall) on every wallet before
// round N+1 starts, or round N's late close could land mid-N+1.
import { describe, expect, it } from "vitest";
import type { NadoGateway } from "@farm/adapter-nado";
import type { Order, Position } from "@farm/adapter-api";
import { assertCohortFlatSettled, cohortResidue, CohortNotFlatError, type CohortSettleDeps } from "./cohort-settle.js";

const pos = (market: string, size: string): Position => ({ market, side: size.startsWith("-") ? "short" : "long", size: size as never,
  entryPrice: "0" as never, markPrice: "0" as never, unrealizedPnl: "0" as never, leverage: 0, marginMode: "cross", raw: null });
const order = (market: string): Order => ({ clientId: "x", market, side: "buy", kind: "limit", role: "maker",
  size: "1" as never, filled: "0" as never, remaining: "1" as never, postOnly: true, reduceOnly: false, status: "open", createdMs: 0, updatedMs: 0, raw: null });

function fakeGateway(state: Record<string, { positions?: Position[]; openOrders?: Order[] }>): CohortSettleDeps {
  const unused = () => { throw new Error("UNUSED_GATEWAY_METHOD"); };
  return {
    forOwner(owner: string): NadoGateway {
      const s = state[owner.toLowerCase()] ?? {};
      return {
        async getPositions() { return s.positions ?? []; },
        async getOpenOrders() { return s.openOrders ?? []; },
        submitOrder: unused, cancelOrders: unused, getMarkets: unused,
        getOrderBook: unused, getFills: unused, getBalances: unused,
      } as unknown as NadoGateway;
    },
  };
}

const A = "0x" + "1".repeat(40), B = "0x" + "2".repeat(40), C = "0x" + "3".repeat(40);

describe("cohort-settle — between-rounds flat gate", () => {
  it("passes when every wallet is flat (no position, no open orders)", async () => {
    const deps = fakeGateway({ [A]: { positions: [pos("nado:perp:BTC-PERP", "0")] }, [B]: {}, [C]: { positions: [] } });
    expect(await cohortResidue([A, B, C], deps)).toEqual([]);
    await expect(assertCohortFlatSettled([A, B, C], deps)).resolves.toBeUndefined();
  });

  it("flags a wallet still holding a position", async () => {
    const deps = fakeGateway({ [A]: {}, [B]: { positions: [pos("nado:perp:BTC-PERP", "0.5")] } });
    const residue = await cohortResidue([A, B], deps);
    expect(residue).toHaveLength(1);
    expect(residue[0]!.owner).toBe(B);
    expect(residue[0]!.openPositions).toEqual(["nado:perp:BTC-PERP"]);
    await expect(assertCohortFlatSettled([A, B], deps)).rejects.toBeInstanceOf(CohortNotFlatError);
  });

  it("flags a wallet with a resting order even if flat on position", async () => {
    const deps = fakeGateway({ [A]: { openOrders: [order("nado:perp:BTC-PERP")] } });
    const residue = await cohortResidue([A], deps);
    expect(residue[0]!.openOrderCount).toBe(1);
  });

  it("treats a short (negative) position as not flat", async () => {
    const deps = fakeGateway({ [A]: { positions: [pos("nado:perp:ETH-PERP", "-2")] } });
    expect((await cohortResidue([A], deps))[0]!.openPositions).toEqual(["nado:perp:ETH-PERP"]);
  });

  it("honours the Phase-C inFlightRecall seam (absent in Phase A → always settled)", async () => {
    const deps = fakeGateway({ [A]: {} });
    expect(await cohortResidue([A], deps)).toEqual([]); // no hook: flat
    const residue = await cohortResidue([A], deps, { inFlightRecall: (o) => o === A });
    expect(residue[0]!.recallInFlight).toBe(true);
  });

  it("reports ALL offending wallets, not just the first", async () => {
    const deps = fakeGateway({ [A]: { positions: [pos("m", "1")] }, [B]: {}, [C]: { openOrders: [order("m")] } });
    const err = await assertCohortFlatSettled([A, B, C], deps).catch((e) => e as CohortNotFlatError);
    expect(err).toBeInstanceOf(CohortNotFlatError);
    expect((err as CohortNotFlatError).residue.map((r) => r.owner).sort()).toEqual([A, C].sort());
  });

  it("fails CLOSED on an unparseable position size (NaN/empty/garbage ⇒ NOT flat)", async () => {
    // A safety gate must never report an unknown size as settled; only a well-formed 0 is flat.
    for (const bad of ["abc", "1,000", "", "   ", "Infinity", "1 USDT"]) {
      const deps = fakeGateway({ [A]: { positions: [pos("m", bad)] } });
      const residue = await cohortResidue([A], deps);
      expect(residue, `size ${JSON.stringify(bad)} must be treated as NOT flat`).toHaveLength(1);
      expect(residue[0]!.openPositions).toEqual(["m"]);
    }
    const flat = fakeGateway({ [A]: { positions: [pos("m", "0"), pos("n", "0.0")] } });
    expect(await cohortResidue([A], flat)).toEqual([]);
  });
});
