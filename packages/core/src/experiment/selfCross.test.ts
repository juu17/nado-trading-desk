// A-3 self-cross: the capacity driver's fill mechanism (locked decision #2 — A↔B cross IS
// how fills are made). Proves a round runs end to end with NO external flow: A posts a
// resting maker, B's taker deliberately CROSSES it (both fill each other), hold≈0, then the
// close mirrors (B rests a reduce maker, A's taker crosses it), ending flat. The fake
// connector models a real CLOB cross (a taker consumes a resting opposite-side maker), so the
// self-match is exercised, not assumed. Organic mode (selfCross off) is untouched — the 87
// coordinator cases still pin it.
import { describe, expect, it } from "vitest";
import { emptyOperations, type DeskOperations, type OperationsStore } from "../funding/types.js";
import { TURBO_SLOT_MS } from "./timing.js";
import { ExperimentCoordinator } from "./coordinator.js";
import type { ExperimentCampaign, ExperimentCampaignInput, ExperimentConnector, ExperimentOrder, ExperimentOrderFact, ExperimentOrderRequest, PreparedExperimentOrder } from "./types.js";

const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");

class Store implements OperationsStore<ExperimentCampaign> {
  state = emptyOperations<ExperimentCampaign>();
  async read() { return structuredClone(this.state); }
  async update<T>(fn: (s: DeskOperations<ExperimentCampaign>) => T) { const copy = structuredClone(this.state), r = fn(copy); this.state = copy; return r; }
}

// A minimal single-product CLOB: post-only orders REST; a taker CROSSES the best resting
// maker of the opposite side, filling min(taker, maker-remaining) and moving both positions.
// This is what makes the A↔B self-match real in the test.
function selfCrossFixture(opts: { externalLiquidity?: boolean; bOpenPrepareFails?: boolean; closeMakerRefuses?: boolean } = {}) {
  const store = new Store();
  let now = 0, seq = 1;
  const positions = new Map<string, bigint>();
  // digest -> live order record
  const orders = new Map<string, { owner: string; side: "BUY" | "SELL"; qty: bigint; filled: bigint; postOnly: boolean; resting: boolean; terminal: boolean; productId: number }>();
  const requests = new Map<string, ExperimentOrderRequest>();
  const move = (owner: string, side: "BUY" | "SELL", qty: bigint) => positions.set(owner, (positions.get(owner) ?? 0n) + (side === "BUY" ? 1n : -1n) * qty);
  const factOf = (digest: string, now: number): ExperimentOrderFact => {
    const o = orders.get(digest)!;
    return { digest, identityMatches: true, known: true, terminal: o.terminal, filledX18: String(o.filled),
      quoteFilledX18: String(o.filled * 10n), feePaidX18: o.filled > 0n ? "1" : "0", observedAt: now, ...(o.resting && o.filled < o.qty ? { resting: true as const } : {}) };
  };
  const connector: ExperimentConnector = {
    preflight: async (_c, p) => {
      const open = (owner: string) => [...orders.values()].filter((o) => o.owner === owner && o.resting && !o.terminal);
      const snap = (owner: string) => ({ owner, positionX18: String(positions.get(owner) ?? 0n), openDigests: [...orders.entries()].filter(([, o]) => o.owner === owner && o.resting && !o.terminal).map(([d]) => d), equityX18: "100000" });
      void open;
      return { complete: true, observedAt: now, a: snap(p.a), b: snap(p.b) };
    },
    prepare: async (c, pair, request) => {
      // Edge: B's follow is refused at prepare (margin / below-min) — the coordinator early-exits.
      if (opts.bOpenPrepareFails && request.role === "B_OPEN") throw new Error("EXPERIMENT_BELOW_MINIMUM_NOTIONAL");
      requests.set(request.id, request);
      const qty = request.quantityX18 ?? "100"; // A_OPEN uses notional default → 100; follows/closes pass an explicit qty
      return { ...request, mode: c.mode, chainId: c.chainId, productId: c.productId, digest: "0x" + (seq++).toString(16).padStart(64, "0"),
        payload: JSON.stringify({ id: request.id }), quantityX18: qty, priceX18: "10", nonce: String(seq), expiration: 999999 };
    },
    dispatch: async (_c, prepared, allowed) => {
      if (!allowed()) throw Error("STOPPED");
      // Edge: B's post-only reduce-only CLOSE maker is refused as post-only-would-cross (2008) —
      // a never-placed refusal. The coordinator must fall to the taker close (A_CLOSE) and still
      // flatten B, never hang on a lookup of the never-placed order. Its reduce-only takers then
      // close against the (external) book, so the round can reach flat.
      if (opts.closeMakerRefuses && prepared.reduceOnly && prepared.postOnly) throw new Error("ORDER_REFUSED_2008");
      const rec = { owner: prepared.owner, side: prepared.side as "BUY" | "SELL", qty: BigInt(prepared.quantityX18), filled: 0n, postOnly: prepared.postOnly, resting: prepared.postOnly, terminal: false, productId: prepared.productId };
      orders.set(prepared.digest, rec);
      if (!prepared.postOnly && (opts.externalLiquidity || (opts.closeMakerRefuses && prepared.reduceOnly))) {
        // Edge: the taker crosses bottomless EXTERNAL liquidity (other participants), filling
        // fully WITHOUT touching A's/B's resting self-cross maker — so that maker is stranded.
        rec.filled = rec.qty; move(rec.owner, rec.side, rec.qty); rec.terminal = true;
      } else if (!prepared.postOnly) {
        // Taker: cross the oldest resting maker of the opposite side in this product.
        let remaining = rec.qty;
        for (const [, maker] of orders) {
          if (remaining === 0n) break;
          if (!maker.resting || maker.terminal || maker.productId !== rec.productId || maker.side === rec.side) continue;
          const crossed = remaining < maker.qty - maker.filled ? remaining : maker.qty - maker.filled;
          if (crossed <= 0n) continue;
          maker.filled += crossed; move(maker.owner, maker.side, crossed);
          if (maker.filled >= maker.qty) { maker.resting = false; maker.terminal = true; }
          rec.filled += crossed; move(rec.owner, rec.side, crossed); remaining -= crossed;
        }
        rec.terminal = true; // an IOC taker never rests
      }
      return prepared.digest;
    },
    lookup: async (_c, o) => orders.has(o.digest) ? factOf(o.digest, now) : { digest: o.digest, identityMatches: false, known: false, terminal: false, filledX18: "0", quoteFilledX18: null, feePaidX18: null, observedAt: now },
    cancel: async (_c, o, allowed) => {
      if (!allowed()) throw Error("STOPPED");
      const rec = orders.get(o.digest)!; rec.resting = false; rec.terminal = true;
      return factOf(o.digest, now);
    },
    rollover: async () => { throw Error("EXPERIMENT_ROLLOVER_UNSUPPORTED"); },
    lookupRollover: async () => { throw Error("EXPERIMENT_ROLLOVER_UNSUPPORTED"); },
  };
  // chain:true collapses intra-round tick latency; random:0 → round side BUY, hold 0.
  const engine = new ExperimentCoordinator(store, connector, { now: () => now, random: () => 0, chain: true });
  const config: ExperimentCampaignInput = { id: "sx", chainId: 763373, mode: "SIMULATION", productId: 2,
    orderNotionalX18: "1000", targetNotionalPerWalletX18: "1000", slippageBps: 10,
    slotMs: TURBO_SLOT_MS, selfCross: true, closeMaker: "B", maxConcurrency: 10,
    groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }] }] };
  return { store, config, engine, positions, orders, requests,
    current: async () => (await engine.query(config.id))[0]!,
    init: async () => { await engine.create(config); await engine.start(config.id); },
    set now(v: number) { now = v; }, get now() { return now; },
    step: async (n = 1) => { for (let i = 0; i < n; i++) await engine.tick(config.id); } };
}

describe("self-cross A↔B round (no external flow)", () => {
  it("B's taker crosses A's resting maker to open, mirrors to close, and ends flat", async () => {
    const x = selfCrossFixture();
    await x.init();
    // Drive to completion with NO clock advance — hold is 0 and openAt is the slot boundary,
    // so the whole round (open cross → hold → close cross → flat) runs as fast as ticks fire.
    for (let i = 0; i < 40 && (await x.current()).groups[0]!.pairs[0]!.rounds[0]?.state !== "COMPLETED"; i++) await x.step(1);
    const round = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!;
    expect(round.state).toBe("COMPLETED");
    // Both wallets flat (A↔B matched each other on open and on close).
    expect(x.positions.get(address(1)) ?? 0n).toBe(0n);
    expect(x.positions.get(address(2)) ?? 0n).toBe(0n);
    // The self-match shape: A opens a post-only maker, B crosses as taker; the close mirrors
    // (B reduce-maker, A reduce-taker). A never had to wait for outside flow.
    const roles = [...x.requests.values()].map((r) => [r.role, r.postOnly]);
    expect(roles).toContainEqual(["A_OPEN", true]);   // A rests a maker
    expect(roles).toContainEqual(["B_OPEN", false]);  // B crosses it (taker)
    // A_OPEN was filled by B's cross (reconciled to terminal), not by external flow.
    const aOpen = round.orders.find((o) => o.role === "A_OPEN")!;
    expect(aOpen.state).toBe("TERMINAL");
    expect(BigInt(aOpen.filledX18)).toBeGreaterThan(0n);
    // No order left resting / unresolved.
    expect(round.orders.every((o) => o.state === "TERMINAL" || o.state === "ABORTED_UNSENT")).toBe(true);
  });

  it("holds B's taker to A's acked resting size (overfill guard, invariant #5)", async () => {
    const x = selfCrossFixture();
    await x.init();
    for (let i = 0; i < 20 && (await x.current()).groups[0]!.pairs[0]!.rounds[0]?.state === "WAITING_OPEN"; i++) await x.step(1);
    // Once B has crossed, B's cumulative fill never exceeds A's acked resting size.
    for (let i = 0; i < 40 && (await x.current()).groups[0]!.pairs[0]!.rounds[0]?.state !== "COMPLETED"; i++) await x.step(1);
    const round = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!;
    const aOpenQty = BigInt(round.orders.find((o) => o.role === "A_OPEN")!.quantityX18);
    const bFollowed = round.orders.filter((o) => o.role === "B_OPEN" && o.state === "TERMINAL").reduce((n, o) => n + BigInt(o.filledX18), 0n);
    expect(bFollowed).toBeLessThanOrEqual(aOpenQty);
    expect(bFollowed).toBe(aOpenQty); // a clean full cross in the happy path
  });
});

// Failure-path robustness (both post-audits flagged these): an early exit where B does not
// fully cross A must NOT strand A's resting maker (→ EXPERIMENT_A_ORDERS_REMAIN stall / forever
// pause) and must NOT poll A forever. Each case must reach a BOUNDED clean close, flat.
describe("self-cross failure paths close cleanly (no stall, no stranded maker)", () => {
  it("B refused at prepare: early-exits, A's resting open maker is withdrawn, round completes flat", async () => {
    const x = selfCrossFixture({ bOpenPrepareFails: true });
    await x.init();
    for (let i = 0; i < 60 && (await x.current()).groups[0]!.pairs[0]!.rounds[0]?.state !== "COMPLETED"; i++) { await x.step(1); x.now += 200; }
    const round = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!;
    expect(round.state).toBe("COMPLETED");             // bounded clean close, NOT a forever-pause (#5)
    expect(round.earlyExitReason).toBeDefined();
    expect(x.positions.get(address(1)) ?? 0n).toBe(0n);
    expect(x.positions.get(address(2)) ?? 0n).toBe(0n);
    const aOpen = round.orders.find((o) => o.role === "A_OPEN")!;
    expect(["TERMINAL", "ABORTED_UNSENT"]).toContain(aOpen.state); // withdrawn, not left resting
    expect(round.orders.every((o) => o.state === "TERMINAL" || o.state === "ABORTED_UNSENT")).toBe(true);
  });

  it("B crosses external liquidity (A left resting): bounded early-close past the deadline, no hang", async () => {
    const x = selfCrossFixture({ externalLiquidity: true });
    await x.init();
    // B fills its target from external flow; A's maker is never crossed. Past followDeadline the
    // round must early-close both legs rather than poll A forever (#6).
    for (let i = 0; i < 80 && (await x.current()).groups[0]!.pairs[0]!.rounds[0]?.state !== "COMPLETED"; i++) { await x.step(1); x.now += 300; }
    const round = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!;
    expect(round.state).toBe("COMPLETED");             // did NOT hang in B_OPEN (#6)
    expect(round.earlyExitReason).toBeDefined();
    expect(x.positions.get(address(1)) ?? 0n).toBe(0n);
    expect(x.positions.get(address(2)) ?? 0n).toBe(0n);
    const aOpen = round.orders.find((o) => o.role === "A_OPEN")!;
    expect(["TERMINAL", "ABORTED_UNSENT"]).toContain(aOpen.state);
    expect(round.orders.every((o) => o.state === "TERMINAL" || o.state === "ABORTED_UNSENT")).toBe(true);
  });

  it("cancel-on-timeout: A's maker bailed reduce-only when B has not crossed it within makerCrossTimeoutMs", async () => {
    // B sweeps external liquidity (A left resting). With a SHORT cross timeout (500ms) and the
    // TURBO slot's follow deadline at 1000ms, the round must bail at the timeout — bounding A's
    // stranger-exposure BEFORE the slot deadline — and close flat reduce-only.
    const x = selfCrossFixture({ externalLiquidity: true });
    x.config.makerCrossTimeoutMs = 500;
    await x.init();
    const round = async () => (await x.current()).groups[0]!.pairs[0]!.rounds[0];
    // Drive to B_OPEN with A still resting; now=0 < 500 < 1000, so the round HOLDS (no bail yet).
    for (let i = 0; i < 20 && (await round())?.state !== "B_OPEN"; i++) await x.step(1);
    expect((await round())?.state).toBe("B_OPEN");
    expect((await round())?.earlyExitReason).toBeUndefined(); // not bailed yet (now=0)
    // Advance to exactly the cross timeout — still below the 1000ms follow deadline — and step.
    x.now = 500;
    await x.step(1);
    expect((await round())?.earlyExitReason).toBe("FOLLOW_TIMEOUT_EXIT"); // the SHORT timeout fired
    // Finish the reduce-only close; the pair ends flat with A's maker withdrawn.
    for (let i = 0; i < 40 && (await round())?.state !== "COMPLETED"; i++) { await x.step(1); x.now += 50; }
    const r = (await round())!;
    expect(r.state).toBe("COMPLETED");
    expect(x.positions.get(address(1)) ?? 0n).toBe(0n);
    expect(x.positions.get(address(2)) ?? 0n).toBe(0n);
    const aOpen = r.orders.find((o) => o.role === "A_OPEN")!;
    expect(["TERMINAL", "ABORTED_UNSENT"]).toContain(aOpen.state); // A's resting maker withdrawn, not left exposed
    expect(r.orders.every((o) => o.state === "TERMINAL" || o.state === "ABORTED_UNSENT")).toBe(true);
  });

  it("cancel-on-timeout does NOT fire on the happy path (B crosses A within the timeout)", async () => {
    const x = selfCrossFixture(); // no external liquidity → B crosses A cleanly, A reconciles terminal
    x.config.makerCrossTimeoutMs = 500;
    await x.init();
    const round = async () => (await x.current()).groups[0]!.pairs[0]!.rounds[0];
    for (let i = 0; i < 40 && (await round())?.state !== "COMPLETED"; i++) await x.step(1);
    const r = (await round())!;
    expect(r.state).toBe("COMPLETED");
    expect(r.earlyExitReason).toBeUndefined(); // clean full cross, no timeout bail
    expect(x.positions.get(address(1)) ?? 0n).toBe(0n);
    expect(x.positions.get(address(2)) ?? 0n).toBe(0n);
    expect(BigInt(r.orders.find((o) => o.role === "A_OPEN")!.filledX18)).toBeGreaterThan(0n); // A filled by B's cross
  });

  it("B's post-only close maker refused (2008) falls to the taker close and still flattens B, no hang", async () => {
    // closeMaker:"B" posts a SECOND post-only maker every round (decision #2's mirror). Under a
    // moving book it can be refused post-only-would-cross just like A's open. The refusal must
    // resolve locally to terminal/0 (never a lookup of the never-placed order → no transient
    // EXPERIMENT_LOOKUP_UNKNOWN hang) and the close must fall to the taker, flattening B.
    const x = selfCrossFixture({ closeMakerRefuses: true });
    await x.init();
    for (let i = 0; i < 60 && (await x.current()).groups[0]!.pairs[0]!.rounds[0]?.state !== "COMPLETED"; i++) await x.step(1);
    const round = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!;
    expect(round.state).toBe("COMPLETED");                 // did NOT hang in B_CLOSE_MAKER
    expect(x.positions.get(address(1)) ?? 0n).toBe(0n);
    expect(x.positions.get(address(2)) ?? 0n).toBe(0n);    // B was flattened by the taker fallback
    const closeMaker = round.orders.find((o) => o.role === "B_CLOSE" && o.postOnly)!;
    expect(closeMaker).toMatchObject({ state: "TERMINAL", filledX18: "0", errorCode: "ORDER_REFUSED_2008" });
    expect(round.orders.some((o) => o.role === "A_CLOSE" && !o.postOnly)).toBe(true);
    expect(round.orders.every((o) => o.state === "TERMINAL" || o.state === "ABORTED_UNSENT")).toBe(true);
  });
});
