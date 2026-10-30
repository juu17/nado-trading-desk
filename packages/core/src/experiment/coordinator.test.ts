import { describe, expect, it } from "vitest";
import { emptyOperations, type DeskOperations, type OperationsStore } from "../funding/types.js";
import { validateDeskOperations } from "../funding/journal.js";
import { OrderLedger } from "../funding/order-ledger.js";
import { makeWalletUsePlan } from "../funding/wallet-use-plan.js";
import { ExperimentCoordinator, REPRICE_ATTEMPTS } from "./coordinator.js";
import { experimentRoutePlanSha256 } from "./route.js";
// Phase-A port: the funding→experiment circular edge is cut, so the DEEP experiment-slot
// validation (which the funding journal did in lucklab) now lives in the experiment layer —
// the test store runs it explicitly. The admit guard is injected into OrderLedger (the real
// Phase-A wiring) rather than imported inside the ledger (the cut edge). `networkOperationsStore`
// (multi-network) and `assertWalletPlanSwitchSafe` (plan-switch over dropped funding fields)
// are deferred to Phase C; the cases that used them are adapted below.
import { validateExperiments } from "./validation.js";
import { assertExperimentOrderAdmission } from "./guards.js";
import type { ExperimentCampaign, ExperimentCampaignInput, ExperimentConnector, ExperimentOrder, ExperimentOrderFact, ExperimentOrderRequest, ExperimentPair, ExperimentRound, PreparedExperimentOrder } from "./types.js";

const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
class Store implements OperationsStore<ExperimentCampaign> {
  state = emptyOperations<ExperimentCampaign>();
  lane: Promise<unknown> = Promise.resolve();
  onCommit?: (s: DeskOperations<ExperimentCampaign>) => void;
  /** A test that injects a hand-made funding record (not a full journal) turns this off. */
  validate = true;
  async read() { return structuredClone(this.state); }
  update<T>(fn: (s: DeskOperations<ExperimentCampaign>) => T): Promise<T> {
    const p = this.lane.then(() => { const copy = structuredClone(this.state), result = fn(copy); if (this.validate) { validateDeskOperations(copy); validateExperiments(copy); } this.state = copy; this.onCommit?.(copy); return structuredClone(result); });
    this.lane = p.catch(() => {}); return p;
  }
}
function fixture(input: Partial<ExperimentCampaignInput> = {}, random: () => number = () => 0) {
  const store = new Store(); let now = 0, sequence = 1;
  const positions = new Map<string, bigint>(), equity = new Map<string, string>();
  const requests = new Map<string, ExperimentOrderRequest>(), remote = new Map<string, ExperimentOrderFact>();
  const applied = new Map<string, bigint>();
  let sends = 0, cancels = 0, rolls = 0, rollQueries = 0, openFill = 100n, closeFill: bigint | undefined;
  let credit = false, unknownDispatch = false;
  let beforePrepare: ((request: ExperimentOrderRequest) => Promise<void>) | undefined;
  const config: ExperimentCampaignInput = { id: "campaign", chainId: 763373, mode: "SIMULATION", productId: 2,
    orderNotionalX18: "1000", targetNotionalPerWalletX18: "2000", maxLossPerWalletX18: "1000", maxFeePerWalletX18: "1000", slippageBps: 10,
    groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }] }], ...input };
  const factFor = (order: PreparedExperimentOrder, qty: bigint, terminal: boolean): ExperimentOrderFact => ({ digest: order.digest, identityMatches: true, known: true,
    terminal, filledX18: String(qty), quoteFilledX18: String(qty * 10n), feePaidX18: qty ? "1" : "0", observedAt: now });
  const applyPosition = (order: ExperimentOrder, fact: ExperimentOrderFact) => {
    const qty = BigInt(fact.filledX18), prior = applied.get(order.digest) ?? 0n;
    if (qty >= prior) { positions.set(order.owner, (positions.get(order.owner) ?? 0n) + (order.side === "BUY" ? 1n : -1n) * (qty - prior)); applied.set(order.digest, qty); }
  };
  const connector: ExperimentConnector = {
    preflight: async (_c, p) => ({ complete: true, observedAt: now,
      a: { owner: p.a, positionX18: String(positions.get(p.a) ?? 0n), openDigests: [], equityX18: equity.get(p.a) ?? "100000" },
      b: { owner: p.b, positionX18: String(positions.get(p.b) ?? 0n), openDigests: [], equityX18: equity.get(p.b) ?? "100000" } }),
    prepare: async (c, _p, request) => {
      await beforePrepare?.(request);
      requests.set(request.id, request);
      return { ...request, mode: c.mode, chainId: c.chainId, productId: c.productId, digest: "0x" + (sequence++).toString(16).padStart(64, "0"),
        payload: JSON.stringify({ signed: request.id }), quantityX18: request.quantityX18 ?? "100", priceX18: "10", nonce: String(sequence), expiration: 999999 };
    },
    dispatch: async (_c, prepared, allowed) => {
      if (!allowed()) throw Error("STOPPED");
      sends++;
      const req = requests.get(prepared.id)!;
      const qty = req.role === "A_OPEN" ? openFill : req.role === "A_CLOSE" && prepared.postOnly ? closeFill ?? BigInt(prepared.quantityX18) : BigInt(prepared.quantityX18);
      remote.set(prepared.digest, factFor(prepared, qty, !prepared.postOnly));
      if (unknownDispatch) throw Error("TIMEOUT");
      return prepared.digest;
    },
    lookup: async (_c, order) => {
      const fact = remote.get(order.digest);
      if (!fact) return { digest: order.digest, identityMatches: false, known: false, terminal: false, filledX18: "0", quoteFilledX18: null, feePaidX18: null, observedAt: now };
      applyPosition(order, fact); return { ...fact, observedAt: now, ...(!fact.terminal && fact.filledX18 === "0" ? { resting: true as const } : {}) };
    },
    cancel: async (_c, order, allowed) => {
      if (!allowed()) throw Error("STOPPED"); cancels++;
      const fact = remote.get(order.digest)!;
      const terminal = { ...fact, terminal: true, observedAt: now }; remote.set(order.digest, terminal); applyPosition(order, terminal); return terminal;
    },
    rollover: async (c, step, allowed) => {
      expect(allowed()).toBe(true);
      expect((await store.read()).experiments!.find(row => row.id === c.id)!.rollovers.find(row => row.id === step.id)!.state).toBe("DISPATCHED");
      rolls++; return { id: step.id, identityMatches: true, state: credit ? "CREDITED" : "PENDING" };
    },
    lookupRollover: async (_c, step) => { rollQueries++; return { id: step.id, identityMatches: true, state: credit ? "CREDITED" : "PENDING" }; },
  };
  const engine = new ExperimentCoordinator(store, connector, { now: () => now, random });
  const current = async () => (await engine.query(config.id))[0]!;
  const step = async (n = 1) => { for (let i = 0; i < n; i++) await engine.tick(config.id); return current(); };
  const until = async (test: (c: ExperimentCampaign) => boolean, max = 60) => { for (let i = 0; i < max; i++) { const c = await current(); if (test(c)) return c; await step(); } throw Error("STATE_TIMEOUT:" + JSON.stringify(await current())); };
  return { store, config, connector, engine, positions, equity, requests, remote, current, step, until,
    init: async () => { await engine.create(config); await engine.start(config.id); },
    set now(v: number) { now = v; }, get now() { return now; },
    set openFill(v: bigint) { openFill = v; }, set closeFill(v: bigint) { closeFill = v; },
    set credit(v: boolean) { credit = v; }, set unknownDispatch(v: boolean) { unknownDispatch = v; },
    set beforePrepare(fn: ((request: ExperimentOrderRequest) => Promise<void>) | undefined) { beforePrepare = fn; },
    get sends() { return sends; }, get cancels() { return cancels; }, get rolls() { return rolls; }, get rollQueries() { return rollQueries; } };
}

describe("persisted randomized reverse-follow experiments", () => {
  // [Phase-A deferred] "a pair whose credited deposit turned UNKNOWN opens no new round":
  // the funding-readiness / depositConflict gate reads the dropped `onboarding`/`funding`
  // desk fields (funding is Phase C; depositConflict is stubbed). Removed, not skipped —
  // it cannot compile against the trimmed desk document. Guards deferred code, not the A/B loop.
  it("counts a continue after a pause, but not the first start",async()=>{
    const x=fixture();await x.init();expect((await x.current()).resumeCount).toBeUndefined();
    await x.engine.stop();await x.engine.start(x.config.id);
    expect((await x.current()).resumeCount).toBe(1);
  });
  it("a newer synchronous Stop still defeats exit intent while its persistence is awaiting",async()=>{
    const x=fixture();await x.init();
    x.store.onCommit=s=>{if(s.experiments?.[0]?.exitRequested)x.engine.halt();};
    await expect(x.engine.requestExit(x.config.id)).rejects.toThrow("EXPERIMENT_STOPPED_DURING_EXIT");
    await x.step(3);expect(x.sends).toBe(0);
  });
  it("records a stopped exposure's exit intent without resuming, then closes only after explicit start admission",async()=>{
    const x=fixture();await x.init();await x.until(c=>c.groups[0]!.pairs[0]!.rounds[0]?.state==="HOLDING");
    await x.engine.stop();const sent=x.sends;await x.engine.reconcile();
    await x.engine.requestExit(x.config.id);await x.step(3);expect(x.sends).toBe(sent);
    expect((await x.current()).exitRequested).toBe(true);
    await x.engine.start(x.config.id);await x.until(c=>c.state==="COMPLETED");
    expect(x.sends).toBe(sent+2);expect(x.positions.get(address(1))).toBe(0n);expect(x.positions.get(address(2))).toBe(0n);
  });
  it("admits an eligible late first-minute entry in one tick and redraws a missed window instead of pinning a late offset",async()=>{
    let late=true;
    const x=fixture({},()=>late?0.9999:0.25);await x.init();await x.step();
    let r=(await x.current()).groups[0]!.pairs[0]!.rounds[0]!;
    expect(r.openAt).toBe(59994);x.now=59995;await x.step();
    expect(x.sends).toBe(1);
    const y=fixture({},()=>late?0.9999:0.25);await y.init();await y.step();
    y.now=240001;late=false;await y.step();
    r=(await y.current()).groups[0]!.pairs[0]!.rounds[0]!;
    expect(r.openAt).toBe(315000);expect(r.side).toBe("SELL");expect(r.holdMs).toBe(179994);
    y.now=315000;await y.step();expect(y.sends).toBe(1);
  });
  it("holds only after A terminal cancellation and B actual full fill, then closes both and verifies flat before completion", async () => {
    const x = fixture(); await x.init();
    let c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    const round = c.groups[0]!.pairs[0]!.rounds[0]!;
    expect(round.side).toBe("BUY"); expect(round.holdUntil).toBe(120000); expect(x.cancels).toBe(1); expect(x.sends).toBe(2);
    x.now = 119999; await x.step(3); expect(x.sends).toBe(2);
    x.now = 120000; c = await x.until(c => c.state === "COMPLETED");
    expect(x.sends).toBe(4); expect(x.positions.get(address(1))).toBe(0n); expect(x.positions.get(address(2))).toBe(0n);
    expect(c.wallets[address(1)]!.quoteFilledX18).toBe("2000"); expect(c.wallets[address(2)]!.quoteFilledX18).toBe("2000");
    expect([...x.requests.values()].map(r => [r.role, r.postOnly, r.reduceOnly])).toEqual([["A_OPEN", true, false], ["B_OPEN", false, false], ["A_CLOSE", true, true], ["B_CLOSE", false, true]]);
  });
  it("persists random times/direction/hold and does not resample after restart or schedule outside the first minute", async () => {
    const x = fixture(); x.now = 60001; await x.init(); await x.step();
    const r = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!;
    expect(r.openAt).toBe(300000); expect(r.openAt % 300000).toBeLessThan(60000);
    const reboot = new ExperimentCoordinator(x.store, x.connector, { now: () => x.now, random: () => 0.99 });
    await reboot.recover(); expect((await reboot.query())[0]!.groups[0]!.pairs[0]!.rounds[0]).toEqual(r);
    expect(x.sends).toBe(0);
  });
  it("uses the actual partial A fill only after cancelling the rest", async () => {
    const x = fixture(); x.openFill = 40n; await x.init();
    await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    const b = [...x.requests.values()].find(r => r.role === "B_OPEN")!;
    expect(b.quantityX18).toBe("40"); expect(x.cancels).toBe(1);
  });
  it("waits for cumulative source fills to reach the persisted hedge minimum before cancelling and following", async () => {
    const x = fixture(), prepare = x.connector.prepare; x.openFill = 40n;
    x.connector.prepare = async (c, p, req) => ({ ...await prepare(c, p, req), ...(req.role === "A_OPEN" ? { minimumHedgeQuantityX18: "80" } : {}) });
    await x.init(); await x.step(6);
    let c = await x.current(), source = c.groups[0]!.pairs[0]!.rounds[0]!.orders[0]!;
    expect(source.minimumHedgeQuantityX18).toBe("80"); expect(source.filledX18).toBe("40"); expect(x.cancels).toBe(0); expect(x.sends).toBe(1);
    x.remote.set(source.digest, { ...x.remote.get(source.digest)!, filledX18: "70", quoteFilledX18: "700" }); await x.step(2);
    expect(x.cancels).toBe(0); expect(x.sends).toBe(1);
    x.remote.set(source.digest, { ...x.remote.get(source.digest)!, filledX18: "80", quoteFilledX18: "800" });
    c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    expect(x.cancels).toBe(1); expect([...x.requests.values()].find(r => r.role === "B_OPEN")!.quantityX18).toBe("80");
    expect(c.groups[0]!.pairs[0]!.rounds[0]!.earlyExitReason).toBeUndefined();
  });
  it("after timeout and proven cancellation, closes a subminimum source fill without inflating or submitting B", async () => {
    const x = fixture(), prepare = x.connector.prepare; x.openFill = 40n;
    x.connector.prepare = async (c, p, req) => ({ ...await prepare(c, p, req), ...(req.role === "A_OPEN" ? { minimumHedgeQuantityX18: "80" } : {}) });
    await x.init(); await x.step(6); expect(x.cancels).toBe(0); x.now = 30000;
    const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "COMPLETED"), round = c.groups[0]!.pairs[0]!.rounds[0]!;
    expect(round.earlyExitReason).toBe("SOURCE_BELOW_MINIMUM_EXIT"); expect(round.pairedAt).toBeUndefined();
    expect(round.orders.map(o => o.role)).toEqual(["A_OPEN", "A_CLOSE"]);
    expect(round.orders[0]!.cancelState).toBe("CONFIRMED"); expect(round.orders[1]).toMatchObject({ quantityX18: "40", reduceOnly: true });
    expect(x.positions.get(address(1))).toBe(0n); expect(c.wallets[address(1)]!.quoteFilledX18).toBe("800"); expect(c.wallets[address(2)]!.quoteFilledX18).toBe("0");
  });
  it("a sibling's proven terminal cancellation below the minimum also follows the source-only risk-exit path", async () => {
    const x = fixture(), prepare = x.connector.prepare; x.openFill = 40n;
    x.connector.prepare = async (c, p, req) => ({ ...await prepare(c, p, req), ...(req.role === "A_OPEN" ? { minimumHedgeQuantityX18: "80" } : {}) });
    await x.init(); await x.step(3); const source = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!.orders[0]!;
    x.remote.set(source.digest, { ...x.remote.get(source.digest)!, terminal: true });
    const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "COMPLETED");
    expect(c.groups[0]!.pairs[0]!.rounds[0]!.earlyExitReason).toBe("SOURCE_BELOW_MINIMUM_EXIT");
    expect([...x.requests.values()].some(r => r.role === "B_OPEN")).toBe(false); expect(x.positions.get(address(1))).toBe(0n);
  });
  it("a precise local B prepare minimum refusal exits the full source without claiming an uncertain B order", async () => {
    const x = fixture(), prepare = x.connector.prepare;
    x.connector.prepare = async (c, p, req) => { if (req.role === "B_OPEN") throw Error("EXPERIMENT_BELOW_MINIMUM_NOTIONAL"); return prepare(c, p, req); };
    await x.init(); const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "COMPLETED"), round = c.groups[0]!.pairs[0]!.rounds[0]!;
    expect(round.earlyExitReason).toBe("SOURCE_BELOW_MINIMUM_EXIT"); expect(round.orders.map(o => o.role)).toEqual(["A_OPEN", "A_CLOSE"]);
    expect(round.orders[0]!.filledX18).toBe("100"); expect(x.sends).toBe(2); expect(x.positions.get(address(1))).toBe(0n);
  });
  it("the same minimum-looking error after B dispatch stays UNKNOWN rather than entering the local prepare shortcut", async () => {
    const x = fixture(), dispatch = x.connector.dispatch;
    x.connector.dispatch = async (c, prepared, allowed) => { if (prepared.owner === address(2)) throw Error("EXPERIMENT_BELOW_MINIMUM_NOTIONAL"); return dispatch(c, prepared, allowed); };
    await x.init(); const c = await x.until(c => c.groups[0]!.pairs[0]!.state === "PAUSED"), round = c.groups[0]!.pairs[0]!.rounds[0]!;
    expect(c.state).toBe("RUNNING"); expect(c.groups[0]!.pairs[0]!.errorCode).toBe("EXPERIMENT_DISPATCH_UNKNOWN");
    expect(round.earlyExitReason).toBeUndefined(); expect(round.orders.find(o => o.role === "B_OPEN")!.state).toBe("UNKNOWN");
    expect(x.positions.get(address(1))).toBe(100n); expect(round.orders.some(o => o.role === "A_CLOSE")).toBe(false);
    // Automatic resume a minute later only queries the original B digest; nothing is re-sent.
    for (let i = 1; i <= 3; i++) { x.now = i * 60000; await x.step(2); }
    const after = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!;
    expect(after.orders.filter(o => o.role === "B_OPEN")).toHaveLength(1); expect(after.orders.find(o => o.role === "B_OPEN")!.state).toBe("UNKNOWN");
  });
  it("rejects a source hedge minimum above its full quantity before claim or dispatch", async () => {
    const x = fixture(), prepare = x.connector.prepare;
    x.connector.prepare = async (c, p, req) => ({ ...await prepare(c, p, req), minimumHedgeQuantityX18: "101" });
    await x.init(); let c = await x.until(c => c.groups[0]!.pairs[0]!.state === "PAUSED");
    expect(c.groups[0]!.pairs[0]!.errorCode).toBe("EXPERIMENT_SIZE_HEDGE_INFEASIBLE"); expect(x.sends).toBe(0);
    expect(c.groups[0]!.pairs[0]!.rounds[0]!.orders).toEqual([]);
    // 1.4.0 unattended rule: a non-network error keeps retrying by itself with growing
    // spacing (1, 2, 4, 8, then 10 minutes); after 3 attempts the task shows a notice.
    const gaps: number[] = [];
    for (let i = 0; i < 40 && ((c = await x.current()).groups[0]!.pairs[0]!.retryCount ?? 0) < 6; i++) {
      const p = c.groups[0]!.pairs[0]!, r = p.rounds[0]!;
      if (p.retryAt !== undefined) { const before = p.retryCount; x.now = Math.max(p.retryAt, r.openAt); await x.step();
        const after = (await x.current()).groups[0]!.pairs[0]!; if (after.retryCount !== before && after.retryAt !== undefined) gaps.push(after.retryAt - x.now); }
      else { x.now = Math.max(x.now + 60000, r.openAt); await x.step(); }
    }
    expect(c.groups[0]!.pairs[0]!.state).toBe("PAUSED"); expect(c.groups[0]!.pairs[0]!.retryAt).toBeDefined(); expect(c.groups[0]!.pairs[0]!.retryCount).toBeGreaterThanOrEqual(6);
    expect(c.errorCode).toBe("EXPERIMENT_PAIR_NEEDS_REVIEW"); expect(x.sends).toBe(0);
    expect(gaps.slice(0, 2)).toEqual([120000, 240000]); // growing spacing (see experimentRetryDelay)
  });
  it("persists independent SELL direction and a hold inside 120–180 seconds", async () => {
    const x = fixture({}, () => 0.75); await x.init(); await x.step();
    const planned = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!;
    expect(planned.openAt).toBe(45000); expect(planned.side).toBe("SELL"); expect(planned.holdMs).toBe(165000);
    x.now = planned.openAt; await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    expect([...x.requests.values()].map(r => r.side)).toEqual(["SELL", "BUY"]);
  });
  it("minimum-size refusal preserves A exposure and never fabricates or rounds up a B fill", async () => {
    const x = fixture(), prepare = x.connector.prepare;
    x.connector.prepare = async (c, p, req) => { if (req.role === "B_OPEN") throw Error("MINIMUM_SIZE"); return prepare(c, p, req); };
    await x.init(); const c = await x.until(c => c.groups[0]!.pairs[0]!.state === "PAUSED");
    expect(x.sends).toBe(1); expect(c.wallets[address(1)]!.quoteFilledX18).toBe("1000"); expect(c.wallets[address(2)]!.quoteFilledX18).toBe("0");
    expect(x.positions.get(address(1))).toBe(100n);
  });
  it("does not open an expired first-minute slot or resample its persisted side/hold", async () => {
    const x = fixture(); await x.init(); await x.step(); const old = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!;
    x.now = 240000; await x.step(3); const round = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!;
    expect(x.sends).toBe(0); expect(round.openAt).toBe(300000); expect(round.side).toBe(old.side); expect(round.holdMs).toBe(old.holdMs);
  });
  it("after a proven zero-fill maker close cancellation, uses a new stable reduce-only IOC attempt for the real remainder", async () => {
    const x = fixture(); x.closeFill = 0n; await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    x.now = 120000; await x.step(3); x.now = 150000;
    const c = await x.until(c => c.state === "COMPLETED");
    const closes = c.groups[0]!.pairs[0]!.rounds[0]!.orders.filter(o => o.role === "A_CLOSE");
    expect(closes).toHaveLength(2); expect(closes[0]!.filledX18).toBe("0"); expect(closes[0]!.cancelState).toBe("CONFIRMED");
    expect(closes[1]).toMatchObject({ postOnly: false, reduceOnly: true, filledX18: "100" });
    expect(closes[0]!.id).not.toBe(closes[1]!.id); expect(x.sends).toBe(5);
  });
  it("treats exact terminal zero-fill cancel as an empty round, without inventing a B fill", async () => {
    const x = fixture(); x.openFill = 0n; await x.init(); await x.step(4);
    // Unfilled makers are re-posted through the open window, then the round ends empty.
    for (const at of [30000, 60000, 90000, 120000]) { x.now = at; await x.step(4); }
    x.now = 240000;
    const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "COMPLETED");
    const orders = c.groups[0]!.pairs[0]!.rounds[0]!.orders;
    expect(orders.length).toBeGreaterThan(1); expect(orders.every(o => o.role === "A_OPEN" && o.filledX18 === "0")).toBe(true);
    expect(c.wallets[address(1)]!.quoteFilledX18).toBe("0"); expect(c.wallets[address(2)]!.quoteFilledX18).toBe("0");
  });
  it("blocks sends if stopped during signing or after the persisted claim", async () => {
    const x = fixture(); await x.init(); x.beforePrepare = async () => x.engine.stop(x.config.id); await x.step(4);
    expect(x.sends).toBe(0);
    const y = fixture(); await y.init(); y.store.onCommit = s => { if (s.experiments?.some(c => c.groups.some(g => g.pairs.some(p => p.rounds.some(r => r.orders.some(o => o.state === "PREPARED")))))) y.engine.halt(); };
    await y.step(4); expect(y.sends).toBe(0);
    expect((await y.current()).groups[0]!.pairs[0]!.rounds[0]!.orders[0]!.state).toBe("ABORTED_UNSENT");
  });
  it("UNKNOWN and restart only query the original digest and do not dispatch again", async () => {
    const x = fixture(); x.unknownDispatch = true; await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.state === "PAUSED");
    expect(x.sends).toBe(1);
    const original = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!.orders[0]!.digest;
    const reboot = new ExperimentCoordinator(x.store, x.connector, { now: () => x.now });
    await reboot.recover(); await reboot.reconcile(x.config.id); await reboot.tick();
    expect(x.sends).toBe(1); expect((await reboot.query())[0]!.groups[0]!.pairs[0]!.rounds[0]!.orders[0]!.digest).toBe(original);
  });
  it("stop during close signing prevents exit writes as well as entry writes", async () => {
    const x = fixture(); await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    x.beforePrepare = async req => { if (req.role === "A_CLOSE") await x.engine.stop(x.config.id); };
    x.now = 120000; await x.step(3); expect(x.sends).toBe(2); expect(x.positions.get(address(1))).toBe(100n);
    expect((await x.current()).state).toBe("STOPPED");
  });
  it("duplicate cumulative observations do not double count, and regressed facts preserve the last exposure", async () => {
    const x = fixture(); await x.init(); await x.step(3); await x.engine.reconcile(x.config.id); const a = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!.orders[0]!;
    await x.engine.reconcile(x.config.id); expect((await x.current()).wallets[address(1)]!.quoteFilledX18).toBe("1000");
    x.remote.set(a.digest, { digest: a.digest, identityMatches: true, known: true, terminal: false, filledX18: "50", quoteFilledX18: "500", feePaidX18: "1", observedAt: x.now });
    await x.engine.reconcile(x.config.id); expect((await x.current()).groups[0]!.pairs[0]!.state).toBe("PAUSED"); expect((await x.current()).wallets[address(1)]!.quoteFilledX18).toBe("1000");
  });
  it("a partial B IOC is followed again for the exact remainder, then the pair holds", async () => {
    const x = fixture(), old = x.connector.lookup;
    x.connector.lookup = async (c, o) => o.role === "B_OPEN" && o.id.endsWith(":1") ? { digest: o.digest, identityMatches: true, known: true, terminal: true, filledX18: "60", quoteFilledX18: "600", feePaidX18: "1", observedAt: x.now } : old(c, o);
    await x.init(); const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    const legs = c.groups[0]!.pairs[0]!.rounds[0]!.orders.filter(o => o.role === "B_OPEN");
    expect(legs.map(o => o.quantityX18)).toEqual(["100", "40"]); expect(legs.map(o => o.filledX18)).toEqual(["60", "40"]);
    expect(c.wallets[address(2)]!.quoteFilledX18).toBe("1000"); expect(c.groups[0]!.pairs[0]!.state).toBe("ACTIVE");
  });
  it("when B cannot match A within its attempts, both real positions close and the round ends flat", async () => {
    const x = fixture(), old = x.connector.lookup;
    x.connector.lookup = async (c, o) => o.role === "B_OPEN" ? { digest: o.digest, identityMatches: true, known: true, terminal: true, filledX18: o.id.endsWith(":1") ? "30" : "0", quoteFilledX18: o.id.endsWith(":1") ? "300" : "0", feePaidX18: "0", observedAt: x.now } : old(c, o);
    // The mock's own position accounting follows the remote fact, so keep it consistent with the lookup.
    const dispatch = x.connector.dispatch;
    x.connector.dispatch = async (c, prepared, allowed) => { const d = await dispatch(c, prepared, allowed); if (prepared.owner === address(2) && !prepared.reduceOnly)
      x.remote.set(prepared.digest, { digest: prepared.digest, identityMatches: true, known: true, terminal: true, filledX18: prepared.id.endsWith(":1") ? "30" : "0", quoteFilledX18: prepared.id.endsWith(":1") ? "300" : "0", feePaidX18: "0", observedAt: x.now }); return d; };
    x.connector.lookup = async (c, o) => { const f = await old(c, o); return f; };
    await x.init(); const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "COMPLETED");
    const r = c.groups[0]!.pairs[0]!.rounds[0]!;
    expect(r.earlyExitReason).toBe("FOLLOWER_INCOMPLETE_EXIT"); expect(r.orders.filter(o => o.role === "B_OPEN")).toHaveLength(6);
    expect(x.positions.get(address(1))).toBe(0n); expect(x.positions.get(address(2))).toBe(0n);
    expect(c.groups[0]!.pairs[0]!.state).not.toBe("PAUSED");
  });
  it("does not complete or reopen while either account still has a position or order", async () => {
    const x = fixture(); await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    x.now = 120000; await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "VERIFYING_FLAT");
    x.positions.set(address(2), 1n); await x.step(); expect((await x.current()).groups[0]!.pairs[0]!.state).toBe("PAUSED"); expect(x.sends).toBe(4);
    for (let i = 1; i <= 5; i++) { x.now = 120000 + i * 60000; await x.step(); }
    expect((await x.current()).groups[0]!.pairs[0]!.rounds).toHaveLength(1); expect(x.sends).toBe(4);
  });
  it("equity loss and fee limits request close-only exit, with no new opening round", async () => {
    const x = fixture(); await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    x.equity.set(address(1), "98000"); await x.until(c => c.state === "COMPLETED");
    expect((await x.current()).exitRequested).toBe(true); expect(x.sends).toBe(4);
    const y = fixture({ maxFeePerWalletX18: "1" }); await y.init(); await y.until(c => c.state === "COMPLETED");
    expect([...y.requests.values()].filter(r => !r.reduceOnly)).toHaveLength(1);
  });
  it("persists ROLLING stable id, advances known pending work only through tick, and waits for credited", async () => {
    const x = fixture({ autoRoll: true, groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }] }, { id: "g2", pairs: [{ id: "p2", a: address(3), b: address(4) }] }] });
    await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING"); x.now = 120000;
    await x.until(c => c.state === "ROLLING"); expect((await x.current()).activeGroup).toBe(0); const rolls = x.rolls;
    x.equity.set(address(1), "0"); x.equity.set(address(2), "0");
    await x.engine.reconcile(); expect(x.rolls).toBe(rolls); expect(x.rollQueries).toBeGreaterThan(0);
    await x.step(); expect(x.rolls).toBeGreaterThan(rolls); expect((await x.current()).activeGroup).toBe(0);
    expect((await x.current()).exitRequested).toBe(false); expect((await x.current()).wallets[address(1)]!.lossX18).toBe("0");
    x.credit = true; await x.step(); expect((await x.current()).activeGroup).toBe(1); expect((await x.current()).rollovers).toHaveLength(1);
  });
  it("reserves active wallets against manual orders and plan switches, including while paused", async () => {
    const x = fixture({ mode: "LIVE" }); await x.init(); await x.step(3);
    const c = await x.current(), o = c.groups[0]!.pairs[0]!.rounds[0]!.orders[0]!;
    let sends = 0;
    const ledger = new OrderLedger(x.store, { dispatch: async row => { sends++; return row.digest; }, lookup: async row => ({ ...row, known: true }) }, 763373, assertExperimentOrderAdmission);
    await ledger.enable();
    const input = { id: "manual", owner: o.owner, chainId: o.chainId, productId: o.productId, digest: o.digest, payload: o.payload,
      quantityX18: o.quantityX18, side: o.side, priceX18: o.priceX18, nonce: o.nonce, expiration: o.expiration };
    await expect(ledger.submit(input)).rejects.toThrow("EXPERIMENT_WALLET_RESERVED");
    await expect(ledger.submit({ ...input, id: `${o.chainId}:${o.id}` })).resolves.toMatchObject({ state: "ACKED" });
    expect(sends).toBe(1);
    await x.engine.stop(); await expect(ledger.submit({ ...input, id: "another" })).rejects.toThrow("EXPERIMENT_WALLET_RESERVED");
  });
  it("never advances an UNKNOWN rollover by replaying writes through read-only reconciliation", async () => {
    const x = fixture({ autoRoll: true, groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }] }, { id: "g2", pairs: [{ id: "p2", a: address(3), b: address(4) }] }] });
    const roll = x.connector.rollover; x.connector.rollover = async (...args) => { await roll(...args); throw Error("TIMEOUT"); };
    await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING"); x.now = 120000;
    let c = await x.until(c => c.rollovers[0]?.state === "UNKNOWN"); expect(x.rolls).toBe(1);
    expect(c.state).toBe("ROLLING"); expect(c.errorCode).toBe("EXPERIMENT_ROLLOVER_UNKNOWN"); expect(c.retryAt).toBeDefined();
    // 1.3.4: looked at again (query first) after 15 s, not a minute.
    expect(c.retryAt! - x.now).toBeLessThanOrEqual(15000);
    await x.engine.reconcile(); expect(x.rolls).toBe(1);
    await x.step(2); expect(x.rolls).toBe(1); expect((await x.current()).activeGroup).toBe(0);
    // The step retries a minute later by querying; once credited the group advances, never paying twice.
    x.credit = true; x.now += 60000; c = await x.until(c => c.activeGroup === 1); expect(x.rolls).toBe(1); expect(c.rollovers[0]!.state).toBe("CREDITED");
  });
  // 1.4.0 network-outage fix: a group transfer whose first attempt failed before anything
  // was sent is looked up (query first) and, answered "pending, nothing open", resent in
  // the same pass; the step keeps retrying by itself and never pauses for the operator.
  it("a rollover whose first attempt failed is resent in the same pass once its lookup says nothing is open", async () => {
    const x = fixture({ autoRoll: true, groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }] }, { id: "g2", pairs: [{ id: "p2", a: address(3), b: address(4) }] }] });
    const roll = x.connector.rollover; let failures = 3;
    x.connector.rollover = async (...args) => { if (failures-- > 0) throw Error("NETWORK_DOWN"); return roll(...args); };
    await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING"); x.now = 120000;
    let c = await x.until(c => c.rollovers[0]?.state === "UNKNOWN"); expect(x.rolls).toBe(0);
    // Two more passes still fail (the network is down): still retried, never paused for good.
    for (let i = 0; i < 2; i++) { x.now = c.retryAt!; await x.step(); c = await x.current(); expect(c.state).toBe("ROLLING"); expect(c.retryAt).toBeDefined(); }
    x.now = c.retryAt!; await x.step(); expect(x.rolls).toBe(1);   // lookup PENDING -> resent in this pass
    x.credit = true; x.now += 60000; c = await x.until(c => c.activeGroup === 1); expect(x.rolls).toBe(1);
  });
  it("validates persisted counters/flags, preserves legacy absence, and isolates campaigns by chain", async () => {
    expect(validateDeskOperations(emptyOperations()).experiments).toBeUndefined();
    const x = fixture(); await x.init(); const bad = await x.store.read(); bad.experiments![0]!.wallets[address(1)]!.quoteFilledX18 = "1";
    // Deep experiment validation lives in the experiment layer now (funding→experiment edge
    // cut): the funding journal validates the slot shallowly; validateExperiments catches a
    // tampered wallet stat.
    expect(() => validateExperiments(bad)).toThrow("JOURNAL_DAMAGED");
    // [Phase-A deferred] Multi-network isolation (networkOperationsStore / NETWORK_EXPERIMENT_SCOPE_ESCAPE)
    // is Phase C, and the Ink-chainId reject is de-pinned (Ink out of core) — those assertions are dropped.
  });
  it("simulation neither unlocks real trading nor reserves real wallets after a stop with virtual exposure", async () => {
    const x = fixture(); await x.init(); await x.step(3);
    expect(x.store.state.tradingStopped).toBe(true); expect(x.store.state.orders).toHaveLength(0);
    await x.engine.stop();
    let sent = 0;
    const ledger = new OrderLedger(x.store, { dispatch: async row => { sent++; return row.digest; }, lookup: async row => ({ ...row, known: true }) }, 763373, assertExperimentOrderAdmission);
    await ledger.enable();
    await expect(ledger.submit({ id: "manual", owner: address(1), chainId: 763373, productId: 2, digest: "0x" + "f".repeat(64), payload: "manual", quantityX18: "1", side: "SELL", priceX18: "10", nonce: "1", expiration: 999999 })).resolves.toMatchObject({ state: "ACKED" });
    expect(sent).toBe(1);
  });
  it("recovery leaves never-started campaigns CREATED and start rechecks the selected wallet plan", async () => {
    const x = fixture({ mode: "LIVE", walletUsePlanId: "first" });
    await x.store.update(s => { s.walletUsePlans = [makeWalletUsePlan("first", "First", "public-account", [address(1), address(2)]), makeWalletUsePlan("second", "Second", "public-account", [address(2), address(1)])]; s.activeWalletUsePlanId = "first"; });
    await x.engine.create(x.config); await x.engine.recover(); expect((await x.current()).state).toBe("CREATED");
    await x.store.update(s => { s.activeWalletUsePlanId = "second"; });
    await expect(x.engine.start(x.config.id)).rejects.toThrow("EXPERIMENT_WALLET_PLAN_MISMATCH"); expect(x.sends).toBe(0);
  });
});

const routed = async (input: ExperimentCampaignInput, funding = address(99)): Promise<ExperimentCampaignInput> => {
  const prep = { initialMarginX18: "1000", gasTargetWei: "1000000000000000", openingDepositX18: "5100000000000000000" };
  const sha256 = await experimentRoutePlanSha256({ ...input, fundingAccount: funding, ...prep });
  return { ...input, route: { fundingAccount: funding, ...prep, sha256, confirmedAt: 1 } };
};
const E18 = 10n ** 18n, u = (n: number) => String(BigInt(n) * E18);
const sized = { sizing: { kind: "CAPITAL_MULTIPLE" as const, multiplier: 10, tailStepX18: u(2000) }, orderNotionalX18: u(6000) };

/** Moves the clock to each round's next scheduled instant so multi-round plans finish. */
async function drive(x: ReturnType<typeof fixture>, done: (c: ExperimentCampaign) => boolean, max = 400) {
  for (let i = 0; i < max; i++) {
    const c = await x.current(); if (done(c)) return c;
    for (const p of c.groups[c.activeGroup]!.pairs) {
      const r = p.rounds.at(-1);
      if (r?.state === "WAITING_OPEN" && x.now < r.openAt) x.now = r.openAt;
      if (r?.state === "HOLDING" && r.holdUntil !== undefined && x.now < r.holdUntil) x.now = r.holdUntil;
    }
    await x.step();
  }
  throw Error("STATE_TIMEOUT:" + JSON.stringify(await x.current()));
}

describe("130-wallet plan: thresholds off, capital-based sizing, routed return and parallel pairs", () => {
  it("absent fee and loss thresholds never exit early while costs keep accumulating", async () => {
    const x = fixture({ maxFeePerWalletX18: undefined, maxLossPerWalletX18: undefined, targetNotionalPerWalletX18: "4000" });
    await x.init(); x.equity.set(address(1), "1");
    const c = await drive(x, c => c.state === "COMPLETED");
    expect(c.exitRequested).toBe(false); expect(c.errorCode).toBeUndefined();
    expect(BigInt(c.wallets[address(1)]!.feePaidX18)).toBeGreaterThan(0n);
    expect(BigInt(c.wallets[address(1)]!.quoteFilledX18)).toBeGreaterThanOrEqual(4000n);
  });
  it("legacy plans that carry a zero threshold still exit on the first positive cost", async () => {
    const x = fixture({ maxFeePerWalletX18: "0", targetNotionalPerWalletX18: "100000" }); await x.init();
    const c = await drive(x, c => c.state === "COMPLETED");
    expect(c.exitRequested).toBe(true); expect(c.errorCode).toBe("EXPERIMENT_COST_LIMIT_EXIT");
  });
  it("sizes each round from the smaller flat capital x10 and opens half of it", async () => {
    const x = fixture({ ...sized, targetNotionalPerWalletX18: u(20000) });
    x.equity.set(address(1), u(900)); x.equity.set(address(2), u(1100));
    await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    const round = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!;
    expect(round.plannedTurnoverX18).toBe(u(9000));
    const open = [...x.requests.values()].find(r => r.role === "A_OPEN")!;
    expect(open.notionalX18).toBe(u(4500)); expect(open.quantityX18).toBeUndefined();
  });
  it("the planned round survives a restart even after equity moved with the open position", async () => {
    const x = fixture({ ...sized, targetNotionalPerWalletX18: u(20000) });
    x.equity.set(address(1), u(1000)); x.equity.set(address(2), u(1000));
    await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    x.equity.set(address(1), u(700));
    await x.engine.stop(); await x.engine.recover(); await x.engine.start(x.config.id); await x.step(2);
    expect((await x.current()).groups[0]!.pairs[0]!.rounds[0]!.plannedTurnoverX18).toBe(u(10000));
  });
  it("a capital-derived open above the confirmed single-order cap pauses the pair instead of sending", async () => {
    const x = fixture({ ...sized, orderNotionalX18: u(4000), targetNotionalPerWalletX18: u(20000) });
    x.equity.set(address(1), u(1000)); x.equity.set(address(2), u(1000));
    await x.init(); const c = await x.until(c => c.groups[0]!.pairs[0]!.state === "PAUSED");
    expect(c.groups[0]!.pairs[0]!.errorCode).toBe("EXPERIMENT_PLAN_ORDER_CAP"); expect(x.sends).toBe(0);
  });
  it("refuses a route confirmation that no longer matches the plan being saved", async () => {
    const base = await routed({ id: "campaign", chainId: 763373, mode: "SIMULATION", productId: 2, orderNotionalX18: "1000", targetNotionalPerWalletX18: "2000",
      slippageBps: 10, groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }] }] });
    const x = fixture({ ...base, targetNotionalPerWalletX18: "3000" });
    await expect(x.engine.create(x.config)).rejects.toThrow("EXPERIMENT_ROUTE_CONFIRMATION_STALE");
    const y = fixture({ ...base, route: { ...base.route!, fundingAccount: address(98) } });
    await expect(y.engine.create(y.config)).rejects.toThrow("EXPERIMENT_ROUTE_CONFIRMATION_STALE");
  });
  it("a routed last group returns to the funding account and completes only after that step is credited", async () => {
    const input = await routed({ id: "campaign", chainId: 763373, mode: "SIMULATION", productId: 2, orderNotionalX18: "1000", targetNotionalPerWalletX18: "2000",
      maxLossPerWalletX18: "1000", maxFeePerWalletX18: "1000", slippageBps: 10, autoRoll: true,
      groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }] }, { id: "g2", pairs: [{ id: "p2", a: address(3), b: address(4) }] }] });
    const x = fixture(input); await x.init();
    await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING"); x.now = 120000;
    await x.until(c => c.state === "ROLLING");
    expect((await x.current()).rollovers[0]).toMatchObject({ fromGroupId: "g1", toGroupId: "g2" });
    x.credit = true; await x.until(c => c.activeGroup === 1); x.credit = false;
    let c = await drive(x, c => c.state === "ROLLING" && c.activeGroup === 1);
    expect(c.rollovers[1]).toMatchObject({ id: "experiment:campaign:roll:1", fromGroupId: "g2", toGroupId: "funding" });
    await x.step(3); expect((await x.current()).state).toBe("ROLLING");
    x.credit = true; c = await x.until(c => c.state === "COMPLETED");
    expect(c.rollovers.map(r => r.state)).toEqual(["CREDITED", "CREDITED"]); expect(c.groups[1]!.completedAt).toBeDefined();
  });
  it("one pair's stalled lookup does not hold back the other pairs of the group", async () => {
    const x = fixture({ maxConcurrency: 2, groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }, { id: "p2", a: address(3), b: address(4) }] }] });
    await x.init(); await x.step();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const lookup = x.connector.lookup;
    x.connector.lookup = async (c, o) => { if (o.owner === address(1)) await gate; return lookup(c, o); };
    const ticking = x.engine.tick(x.config.id);
    for (let i = 0; i < 50 && !x.requests.has("experiment:campaign:p2:1:B_OPEN:1"); i++) await new Promise(r => setTimeout(r, 1));
    // p1 is still waiting on its source lookup inside the same tick.
    const p2 = (await x.current()).groups[0]!.pairs.find(p => p.id === "p2")!;
    expect(p2.rounds[0]!.orders.some(o => o.role === "A_OPEN")).toBe(true);
    release(); await ticking;
  });
});

describe("network outage: automatic pause, minute retries, automatic resume", () => {
  it("waits through an outage mid-round without sending, then finishes the round by itself", async () => {
    const x = fixture(); await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    const sent = x.sends, preflight = x.connector.preflight, lookup = x.connector.lookup; let down = true;
    x.connector.preflight = async (c, p) => { if (down) throw new TypeError("fetch failed"); return preflight(c, p); };
    x.connector.lookup = async (c, o) => { if (down) throw new TypeError("fetch failed"); return lookup(c, o); };
    x.now = 120000; await x.step();
    let c = await x.current();
    expect(c.state).toBe("RUNNING"); expect(c.groups[0]!.pairs[0]!.state).toBe("PAUSED");
    expect(c.groups[0]!.pairs[0]!.errorCode).toBe("EXPERIMENT_NETWORK_UNAVAILABLE"); expect(c.groups[0]!.pairs[0]!.retryAt).toBe(180000);
    // Hours of outage: retried every minute, never a send, never given up.
    for (let i = 1; i <= 120; i++) { x.now = 120000 + i * 60000; await x.step(); }
    c = await x.current(); expect(x.sends).toBe(sent); expect(c.groups[0]!.pairs[0]!.state).toBe("PAUSED"); expect(c.groups[0]!.pairs[0]!.retryAt).toBeDefined();
    down = false; x.now += 60000;
    c = await x.until(c => c.state === "COMPLETED");
    // The held round closes first (its hold had long expired); the target was met by it.
    expect(x.positions.get(address(1))).toBe(0n); expect(x.positions.get(address(2))).toBe(0n);
    expect(c.groups[0]!.pairs[0]!.rounds).toHaveLength(1); expect(c.groups[0]!.pairs[0]!.errorCode).toBeUndefined();
  });
  it("a restart with a request of unknown outcome continues from the breakpoint by querying it first", async () => {
    const x = fixture(); x.unknownDispatch = true; await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.state === "PAUSED");
    x.unknownDispatch = false;
    const lookup = x.connector.lookup; let down = true;
    x.connector.lookup = async (c, o) => { if (down) throw new TypeError("fetch failed"); return lookup(c, o); };
    const reboot = new ExperimentCoordinator(x.store, x.connector, { now: () => x.now });
    await reboot.recover(); down = false;
    expect((await reboot.query())[0]!.state).toBe("STOPPED");
    // The one-button continue: start no longer refuses; the pair re-queries the original digest.
    const started = await reboot.start(x.config.id);
    expect(started.groups[0]!.pairs[0]!.state).toBe("PAUSED"); expect(started.groups[0]!.pairs[0]!.retryAt).toBe(x.now);
    for (let i = 0; i < 60 && (await reboot.query())[0]!.state !== "COMPLETED"; i++) {
      const r = (await reboot.query())[0]!.groups[0]!.pairs[0]!.rounds.at(-1); if (r?.holdUntil && x.now < r.holdUntil) x.now = r.holdUntil; await reboot.tick();
    }
    const c = (await reboot.query())[0]!;
    expect(c.state).toBe("COMPLETED"); expect(c.groups[0]!.pairs[0]!.rounds[0]!.orders.filter(o => o.role === "A_OPEN")).toHaveLength(1);
  });
});

describe("per-round results for win-rate analysis", () => {
  it("records each wallet's realized round result and win/loss counts when the round ends flat", async () => {
    const x = fixture(), lookup = x.connector.lookup;
    // A buys at 10 and sells at 12; B sells at 10 and buys back at 12 (fees 1 per fill).
    const at12 = (o: { role: string }, f: Awaited<ReturnType<typeof lookup>>) => f.known && o.role.endsWith("CLOSE") ? { ...f, quoteFilledX18: String(BigInt(f.filledX18) * 12n) } : f;
    const cancel = x.connector.cancel;
    x.connector.lookup = async (c, o) => at12(o, await lookup(c, o));
    x.connector.cancel = async (c, o, allowed) => at12(o, await cancel(c, o, allowed));
    await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING"); x.now = 120000;
    const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "COMPLETED");
    expect(c.groups[0]!.pairs[0]!.rounds[0]!.result).toEqual({ aPnlX18: String(-1000n + 1200n - 2n), bPnlX18: String(1000n - 1200n - 2n) });
    expect(c.wallets[address(1)]).toMatchObject({ realizedPnlX18: "198", roundsWon: 1, roundsCounted: 1 });
    expect(c.wallets[address(2)]).toMatchObject({ realizedPnlX18: "-202", roundsLost: 1, roundsCounted: 1 });
    expect(c.wallets[address(2)]!.roundsWon).toBeUndefined();
  });
});

describe("audit regressions", () => {
  it("a cancel whose answer was lost is sent again once the order is proven still resting", async () => {
    const x = fixture(); x.openFill = 0n; await x.init(); await x.step(3);
    const cancel = x.connector.cancel; let fail = true;
    x.connector.cancel = async (c, o, allowed) => { if (fail) { fail = false; throw new TypeError("fetch failed"); } return cancel(c, o, allowed); };
    x.now = 30000; await x.step(2);
    let r = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!;
    expect(r.state).toBe("CANCEL_A_OPEN"); expect(r.orders[0]!.cancelState).toBe("UNKNOWN");
    x.now = 95000; await x.step(4);
    r = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!;
    expect(x.cancels).toBe(1); expect(r.orders[0]!.state).toBe("TERMINAL"); expect(r.state).not.toBe("CANCEL_A_OPEN");
  });
  it("a lost cancel is not sent again on a non-terminal fact that does not show the order resting", async () => {
    const x = fixture(); x.openFill = 0n; await x.init(); await x.step(3);
    const cancel = x.connector.cancel, lookup = x.connector.lookup; let fail = true;
    x.connector.cancel = async (c, o, allowed) => { if (fail) { fail = false; throw new TypeError("fetch failed"); } return cancel(c, o, allowed); };
    x.now = 30000; await x.step(2);
    // e.g. an archived partial fill: known, not terminal, but no proof it still rests
    x.connector.lookup = async (c, o) => { const f = await lookup(c, o); return { ...f, resting: undefined }; };
    x.now = 95000; await x.step(4);
    const r = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!;
    expect(x.cancels).toBe(0); expect(r.orders[0]!.cancelState).toBe("UNKNOWN");
  });
  it("a pair paused before its first round still respects the concurrency limit when it resumes", async () => {
    const x = fixture({ maxConcurrency: 1, groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }, { id: "p2", a: address(3), b: address(4) }] }] });
    const preflight = x.connector.preflight; let failP1 = true;
    x.connector.preflight = async (c, p) => { if (p.id === "p1" && failP1) throw new TypeError("fetch failed"); return preflight(c, p); };
    await x.init(); await x.step();
    expect((await x.current()).groups[0]!.pairs[0]!.state).toBe("PAUSED");
    await x.step(); expect((await x.current()).groups[0]!.pairs[1]!.rounds).toHaveLength(1);
    failP1 = false; x.now = 61000; await x.step(2);
    const c = await x.current();
    expect(c.groups[0]!.pairs.filter(p => p.rounds.length).length).toBe(1);
  });
});

describe("capital too small", () => {
  it("an opening the market minimum cannot reach ends the pair as capital too small, without sending", async () => {
    const x = fixture({ ...sized, targetNotionalPerWalletX18: u(1000), groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }] }] });
    x.equity.set(address(1), u(1000)); x.equity.set(address(2), u(1000));
    x.beforePrepare = async req => { if (req.role === "A_OPEN") throw new Error("EXPERIMENT_BELOW_MINIMUM_NOTIONAL"); };
    await x.init(); const c = await x.until(c => c.state === "COMPLETED");
    expect(c.groups[0]!.pairs[0]!.errorCode).toBe("EXPERIMENT_CAPITAL_TOO_SMALL"); expect(x.sends).toBe(0);
  });
  it("a sized pair whose flat capital is below 1 USDT0 ends without trading and lets the group finish", async () => {
    const x = fixture({ ...sized, targetNotionalPerWalletX18: u(20000), groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }] }] });
    x.equity.set(address(1), "5"); x.equity.set(address(2), u(1000));
    await x.init(); const c = await x.until(c => c.state === "COMPLETED");
    expect(c.groups[0]!.pairs[0]!.errorCode).toBe("EXPERIMENT_CAPITAL_TOO_SMALL"); expect(x.sends).toBe(0);
  });
});

describe("fill rate, rejections, pauses and closing until flat", () => {
  it("re-posts an unfilled maker open inside the window, and B follows the attempt that fills", async () => {
    const x = fixture(); x.openFill = 0n; await x.init(); await x.step(3);
    x.openFill = 100n; x.now = 30000;
    const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    const r = c.groups[0]!.pairs[0]!.rounds[0]!, opens = r.orders.filter(o => o.role === "A_OPEN");
    expect(opens.map(o => o.filledX18)).toEqual(["0", "100"]); expect(opens.every(o => o.postOnly)).toBe(true);
    expect(r.orders.filter(o => o.role === "B_OPEN").map(o => o.filledX18)).toEqual(["100"]);
  });
  it("an order the exchange refuses (post-only would cross) is final at once; the pair re-prices without pausing", async () => {
    const x = fixture(), dispatch = x.connector.dispatch, lookup = x.connector.lookup; let refused: string | undefined;
    x.connector.dispatch = async (c, prepared, allowed) => { if (!refused && prepared.postOnly) { refused = prepared.digest; throw new Error("ORDER_REFUSED_2008"); } return dispatch(c, prepared, allowed); };
    x.connector.lookup = async (c, o) => o.digest === refused ? { digest: o.digest, identityMatches: true, known: true, terminal: true, filledX18: "0", quoteFilledX18: "0", feePaidX18: "0", observedAt: x.now } : lookup(c, o);
    await x.init(); await x.step(2);
    expect((await x.current()).groups[0]!.pairs[0]!.state).not.toBe("PAUSED");
    const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    expect(c.groups[0]!.pairs[0]!.rounds[0]!.orders.filter(o => o.role === "A_OPEN").map(o => [o.state, o.filledX18])).toEqual([["TERMINAL", "0"], ["TERMINAL", "100"]]);
  });
  it("A filled, then a pause before B followed: within the slot B follows on resume", async () => {
    const x = fixture(); let stopOnce = true;
    x.beforePrepare = async req => { if (req.role === "B_OPEN" && stopOnce) { stopOnce = false; await x.engine.stop(x.config.id); } };
    await x.init(); await x.step(6);
    expect((await x.current()).state).toBe("STOPPED"); expect(x.positions.get(address(1))).toBe(100n); expect(x.positions.get(address(2)) ?? 0n).toBe(0n);
    x.now = 90000; await x.engine.reconcile(x.config.id); await x.engine.start(x.config.id);
    const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    expect(c.groups[0]!.pairs[0]!.rounds[0]!.earlyExitReason).toBeUndefined(); expect(x.positions.get(address(2))).toBe(-100n);
  });
  it("A filled, then a pause past the round's slot: A is closed, B never enters, the round ends flat", async () => {
    const x = fixture(); let stopOnce = true;
    x.beforePrepare = async req => { if (req.role === "B_OPEN" && stopOnce) { stopOnce = false; await x.engine.stop(x.config.id); } };
    await x.init(); await x.step(6);
    x.now = 600000; await x.engine.reconcile(x.config.id); await x.engine.start(x.config.id);
    const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "COMPLETED");
    const r = c.groups[0]!.pairs[0]!.rounds[0]!;
    expect(r.earlyExitReason).toBe("FOLLOW_TIMEOUT_EXIT");
    expect(r.orders.filter(o => o.role === "B_OPEN" && o.state !== "ABORTED_UNSENT")).toHaveLength(0);
    expect(x.positions.get(address(1))).toBe(0n); expect(x.positions.get(address(2)) ?? 0n).toBe(0n);
  });
  it("keeps closing with widening price bounds until flat, with no attempt cap", async () => {
    const x = fixture(); x.closeFill = 0n; let misses = 5;
    const dispatch = x.connector.dispatch;
    x.connector.dispatch = async (c, prepared, allowed) => { const d = await dispatch(c, prepared, allowed);
      if (prepared.reduceOnly && !prepared.postOnly && prepared.owner === address(1) && misses > 0) { misses--;
        x.remote.set(prepared.digest, { digest: prepared.digest, identityMatches: true, known: true, terminal: true, filledX18: "0", quoteFilledX18: "0", feePaidX18: "0", observedAt: x.now }); }
      return d; };
    await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    x.now = 120000; await x.step(3); x.now = 150000;
    const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "COMPLETED", 120);
    const closes = c.groups[0]!.pairs[0]!.rounds[0]!.orders.filter(o => o.role === "A_CLOSE");
    expect(closes.length).toBe(7); expect(closes.at(-1)!.filledX18).toBe("100");
    const bounds = [...x.requests.values()].filter(r => r.role === "A_CLOSE" && !r.postOnly).map(r => r.slippageBps);
    expect(bounds).toEqual([undefined, 20, 30, 40, 50, 50]);
    expect(x.positions.get(address(1))).toBe(0n); expect(x.positions.get(address(2))).toBe(0n);
  });
});

describe("exchange refusals that repeat", () => {
  const refusing = (code: string, when: (p: PreparedExperimentOrder) => boolean) => {
    const x = fixture(), dispatch = x.connector.dispatch, lookup = x.connector.lookup, refused = new Set<string>();
    x.connector.dispatch = async (c, prepared, allowed) => { if (when(prepared)) { refused.add(prepared.digest); throw new Error(code); } return dispatch(c, prepared, allowed); };
    x.connector.lookup = async (c, o) => refused.has(o.digest) ? { digest: o.digest, identityMatches: true, known: true, terminal: true, filledX18: "0", quoteFilledX18: "0", feePaidX18: "0", observedAt: x.now } : lookup(c, o);
    return x;
  };
  it("a rate limit is no attempt: the order is unsent and the pair backs off a minute", async () => {
    const x = refusing("ORDER_REFUSED_1015", p => p.postOnly); await x.init(); await x.step(2);
    const c = await x.current(), pair = c.groups[0]!.pairs[0]!;
    expect(pair.state).toBe("PAUSED"); expect(pair.errorCode).toBe("EXPERIMENT_RATE_LIMITED"); expect(pair.retryAt).toBe(5000);
    expect(pair.rounds[0]!.orders.map(o => o.state)).toEqual(["ABORTED_UNSENT"]);
  });
  it("the same refusal three times in a row pauses the pair with that reason", async () => {
    const x = refusing("ORDER_REFUSED_2006", p => p.postOnly); await x.init(); await x.step(6);
    const pair = (await x.current()).groups[0]!.pairs[0]!;
    expect(pair.state).toBe("PAUSED"); expect(pair.errorCode).toBe("EXPERIMENT_ORDER_REFUSED_REPEATEDLY");
    expect(pair.rounds[0]!.orders.filter(o => o.errorCode === "ORDER_REFUSED_2006")).toHaveLength(3);
    expect(pair.rounds[0]!.state).toBe("VERIFYING_FLAT");
  });
  it("price-noise refusals on closes never pause: closing goes on until flat", async () => {
    let misses = 4;
    const x = refusing("ORDER_REFUSED_2056", p => p.reduceOnly && !p.postOnly && p.owner === address(1) && misses-- > 0);
    x.closeFill = 0n; await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    x.now = 120000; await x.step(3); x.now = 150000;
    const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "COMPLETED", 120);
    expect(c.groups[0]!.pairs[0]!.rounds[0]!.orders.filter(o => o.errorCode === "ORDER_REFUSED_2056")).toHaveLength(4);
    expect(x.positions.get(address(1))).toBe(0n); expect(x.positions.get(address(2))).toBe(0n);
  });
  it("a stopped task with no open round can be closed out for collection; one mid-round cannot", async () => {
    const x = fixture(); await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    await x.engine.stop(x.config.id);
    await expect(x.engine.closeOut(x.config.id)).rejects.toThrow("EXPERIMENT_OPEN_ROUND_EXIT_FIRST");
    const y = fixture(); await y.init(); await y.engine.stop(y.config.id);
    const c = await y.engine.closeOut(y.config.id);
    expect(c.state).toBe("COMPLETED"); expect(c.exitRequested).toBe(true);
    await expect(y.engine.start(y.config.id)).rejects.toThrow("EXPERIMENT_COMPLETED");
  });
  it("a malformed-request rejection pauses with its own code, not as an unknown dispatch", async () => {
    const x = refusing("ORDER_REJECTED_2035", p => p.postOnly); await x.init(); await x.step(2);
    const pair = (await x.current()).groups[0]!.pairs[0]!;
    expect(pair.errorCode).toBe("ORDER_REJECTED_2035"); expect(pair.rounds[0]!.orders[0]!.state).toBe("TERMINAL");
  });
  it("the local gate refusing before any send leaves no phantom unknown order", async () => {
    const x = refusing("TRADING_STOPPED", p => p.postOnly); await x.init(); await x.step(2);
    const pair = (await x.current()).groups[0]!.pairs[0]!;
    expect(pair.errorCode).toBe("TRADING_STOPPED"); expect(pair.rounds[0]!.orders.map(o => o.state)).toEqual(["ABORTED_UNSENT"]);
  });
  it("B failing to follow three rounds in a row ends the pair instead of burning fees", async () => {
    const x = fixture(), lookup = x.connector.lookup, dispatch = x.connector.dispatch;
    x.connector.dispatch = async (c, prepared, allowed) => { const d = await dispatch(c, prepared, allowed);
      if (prepared.owner === address(2) && !prepared.reduceOnly) x.remote.set(prepared.digest, { digest: prepared.digest, identityMatches: true, known: true, terminal: true, filledX18: "0", quoteFilledX18: "0", feePaidX18: "0", observedAt: x.now });
      return d; };
    x.connector.lookup = async (c, o) => lookup(c, o);
    await x.init();
    for (let i = 0; i < 400 && (await x.current()).groups[0]!.pairs[0]!.state !== "COMPLETED"; i++) { x.now += 20000; await x.step(); }
    const pair = (await x.current()).groups[0]!.pairs[0]!;
    expect(pair.state).toBe("COMPLETED"); expect(pair.errorCode).toBe("EXPERIMENT_FOLLOW_REPEATEDLY_FAILED");
    expect(pair.rounds.filter(r => r.earlyExitReason === "FOLLOWER_INCOMPLETE_EXIT")).toHaveLength(3);
    expect(x.positions.get(address(1))).toBe(0n);
  });
});

describe("makers keep the best price", () => {
  it("a resting maker that is no longer best is re-posted at once; a best one rests until near expiry", async () => {
    const x = fixture(); x.openFill = 0n; let stale = false;
    x.connector.makerStale = async () => stale;
    await x.init(); await x.step(3);
    x.now = 5000; await x.step(3);
    expect((await x.current()).groups[0]!.pairs[0]!.rounds[0]!.orders).toHaveLength(1); // best: keeps resting past 2 s
    x.now = 40000; await x.step(3);
    expect((await x.current()).groups[0]!.pairs[0]!.rounds[0]!.orders).toHaveLength(1); // still best at 40 s (beyond the old 30 s timer)
    stale = true; x.now = 41000; await x.step(4);
    const opens = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!.orders.filter(o => o.role === "A_OPEN");
    expect(opens.length).toBe(2); expect(opens[0]!.state).toBe("TERMINAL"); expect(opens[0]!.cancelState).toBe("CONFIRMED");
  });
});

describe("fair close (B makes, A takes) and pause-and-flatten", () => {
  it("a normal round closes with B's maker order first, then A by taker", async () => {
    const x = fixture({ closeMaker: "B" }); await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    x.now = 130000; const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "COMPLETED");
    const o = c.groups[0]!.pairs[0]!.rounds[0]!.orders.filter(o => o.state !== "ABORTED_UNSENT");
    expect(o.map(o => [o.role, o.postOnly, o.reduceOnly])).toEqual([["A_OPEN", true, false], ["B_OPEN", false, false], ["B_CLOSE", true, true], ["A_CLOSE", false, true]]);
    expect(x.positions.get(address(1))).toBe(0n); expect(x.positions.get(address(2))).toBe(0n);
  });
  it("if B's maker close does not fill in time, A and then B close by taker", async () => {
    const x = fixture({ closeMaker: "B" }), dispatch = x.connector.dispatch;
    x.connector.dispatch = async (c, prepared, allowed) => { const d = await dispatch(c, prepared, allowed);
      if (prepared.owner === address(2) && prepared.postOnly) x.remote.set(prepared.digest, { digest: prepared.digest, identityMatches: true, known: true, terminal: false, filledX18: "0", quoteFilledX18: "0", feePaidX18: "0", observedAt: x.now });
      return d; };
    await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    x.now = 130000; await x.step(4); x.now = 200000;
    const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "COMPLETED");
    const o = c.groups[0]!.pairs[0]!.rounds[0]!.orders.filter(o => o.role.endsWith("CLOSE"));
    expect(o[0]).toMatchObject({ role: "B_CLOSE", postOnly: true, filledX18: "0" });
    expect(o.slice(-2).map(o => [o.role, o.postOnly, o.reduceOnly])).toEqual([["A_CLOSE", false, true], ["B_CLOSE", false, true]]);
    expect(x.positions.get(address(1))).toBe(0n); expect(x.positions.get(address(2))).toBe(0n);
  });
  it("pause-and-flatten closes every open position at once, then stops resumably", async () => {
    const x = fixture({ closeMaker: "B", targetNotionalPerWalletX18: "100000" }); await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    await x.engine.requestFlatten(x.config.id); x.now = 20000;
    const c = await x.until(c => c.state === "STOPPED");
    const r = c.groups[0]!.pairs[0]!.rounds[0]!;
    expect(r.state).toBe("COMPLETED"); expect(r.earlyExitReason).toBe("PAUSE_FLATTEN_EXIT"); expect(c.flattenRequested).toBeUndefined();
    expect(r.orders.filter(o => o.role.endsWith("CLOSE")).every(o => !o.postOnly)).toBe(true);
    expect(x.positions.get(address(1))).toBe(0n); expect(x.positions.get(address(2))).toBe(0n);
    expect(c.groups[0]!.pairs[0]!.rounds).toHaveLength(1);
    await x.engine.start(x.config.id); x.now = 300000; await x.step(3);
    expect((await x.current()).groups[0]!.pairs[0]!.rounds.length).toBe(2);
  });
});

describe("catch-up for lagging pairs", () => {
  it("a pair a full round behind the group's leader gets a larger round, bounded by twice the single-order cap", async () => {
    const x = fixture({ ...sized, catchUpPercent: 200, targetNotionalPerWalletX18: u(50000), maxConcurrency: 2,
      groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }, { id: "p2", a: address(3), b: address(4) }] }] });
    for (const n of [1, 2, 3, 4]) x.equity.set(address(n), u(1000));
    await x.init(); await x.step(2);
    const c = await x.current(), [p1, p2] = c.groups[0]!.pairs;
    // Pretend p1 is one full round (10000) ahead; p2 is the laggard.
    c.wallets[p1!.a]!.quoteFilledX18 = u(10000); c.wallets[p1!.b]!.quoteFilledX18 = u(10000);
    const make = (x.engine as unknown as { makeRound(c: ExperimentCampaign, p: ExperimentPair): ExperimentRound }).makeRound.bind(x.engine);
    const lag = make(c, p2!), lead = make(c, p1!);
    expect(lag.plannedTurnoverX18).toBe(u(12000)); expect(lag.unboostedTurnoverX18).toBe(u(10000));
    expect(lead.plannedTurnoverX18).toBe(u(10000)); expect(lead.unboostedTurnoverX18).toBeUndefined();
  });
});

describe("review fixes: follow margin, refused maker close, interrupted flatten", () => {
  it("B's margin unable to carry A's fill closes A at once instead of pausing unhedged", async () => {
    const x = fixture(); x.beforePrepare = async req => { if (req.role === "B_OPEN") throw new Error("EXPERIMENT_MARGIN_INSUFFICIENT"); };
    await x.init();
    const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "COMPLETED");
    expect(c.groups[0]!.pairs[0]!.state).not.toBe("PAUSED");
    expect(c.groups[0]!.pairs[0]!.rounds[0]!.earlyExitReason).toBe("FOLLOWER_INCOMPLETE_EXIT");
    expect(x.positions.get(address(1))).toBe(0n);
  });
  it("a maker close the exchange refuses for size goes straight to taker closes", async () => {
    const x = fixture({ closeMaker: "B" }), dispatch = x.connector.dispatch, lookup = x.connector.lookup, refused = new Set<string>();
    x.connector.dispatch = async (c, prepared, allowed) => { if (prepared.owner === address(2) && prepared.postOnly) { refused.add(prepared.digest); throw new Error("ORDER_REFUSED_2094"); } return dispatch(c, prepared, allowed); };
    x.connector.lookup = async (c, o) => refused.has(o.digest) ? { digest: o.digest, identityMatches: true, known: true, terminal: true, filledX18: "0", quoteFilledX18: "0", feePaidX18: "0", observedAt: x.now } : lookup(c, o);
    await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    x.now = 130000;
    const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "COMPLETED");
    const closes = c.groups[0]!.pairs[0]!.rounds[0]!.orders.filter(o => o.role.endsWith("CLOSE"));
    expect(closes.filter(o => o.postOnly)).toHaveLength(1);
    expect(x.positions.get(address(1))).toBe(0n); expect(x.positions.get(address(2))).toBe(0n);
  });
  it("a taker close refused three times for the exchange minimum pauses the pair instead of retrying forever", async () => {
    const x = fixture(), dispatch = x.connector.dispatch, lookup = x.connector.lookup, refused = new Set<string>();
    x.connector.dispatch = async (c, prepared, allowed) => { if (prepared.owner === address(1) && prepared.reduceOnly && !prepared.postOnly) { refused.add(prepared.digest); throw new Error("ORDER_REFUSED_2094"); } return dispatch(c, prepared, allowed); };
    x.connector.lookup = async (c, o) => refused.has(o.digest) ? { digest: o.digest, identityMatches: true, known: true, terminal: true, filledX18: "0", quoteFilledX18: "0", feePaidX18: "0", observedAt: x.now } : lookup(c, o);
    x.closeFill = 0n;
    await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    x.now = 200000;
    await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "A_CLOSE" && c.groups[0]!.pairs[0]!.rounds[0]!.orders.some(o => o.role === "A_CLOSE"));
    x.now = 260000;
    const c = await x.until(c => c.groups[0]!.pairs[0]!.state === "PAUSED");
    const p = c.groups[0]!.pairs[0]!;
    expect(p.errorCode).toBe("EXPERIMENT_CLOSE_BELOW_MINIMUM");
    expect(p.rounds[0]!.state).not.toBe("COMPLETED");
    expect(p.rounds[0]!.orders.filter(o => o.role === "A_CLOSE" && !o.postOnly)).toHaveLength(3);
    expect(x.positions.get(address(1))).not.toBe(0n);
  });
  // A classified never-placed refusal (ORDER_REFUSED_<code>) is resolved LOCALLY to terminal /
  // zero-fill from the verdict itself — NOT via connector.lookup, which on the live venue cannot
  // observe a never-placed order (known:false) and would hang the round on a transient
  // EXPERIMENT_LOOKUP_UNKNOWN. These cases pin the local resolve, the A-maker reprice cap, the
  // cross-round backstop, and the market-disabled / at-OI exits.
  it("resolves a classified refusal from the verdict alone, never calling lookup (the live not-found hang is bypassed)", async () => {
    const x = fixture(), dispatch = x.connector.dispatch, lookup = x.connector.lookup; let refused: string | undefined;
    x.connector.dispatch = async (c, prepared, allowed) => { if (!refused && prepared.postOnly) { refused = prepared.digest; throw new Error("ORDER_REFUSED_2008"); } return dispatch(c, prepared, allowed); };
    // The live failure mode made explicit: looking up the refused (never-placed) digest THROWS.
    // If the fix regressed to poll(), this would pause EXPERIMENT_LOOKUP_UNKNOWN and the test fails.
    x.connector.lookup = async (c, o) => { if (o.digest === refused) throw new Error("LOOKUP_MUST_NOT_BE_CALLED_FOR_A_REFUSAL"); return lookup(c, o); };
    await x.init(); await x.step(2);
    expect((await x.current()).groups[0]!.pairs[0]!.state).not.toBe("PAUSED");
    const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    const aOpens = c.groups[0]!.pairs[0]!.rounds[0]!.orders.filter(o => o.role === "A_OPEN");
    expect(aOpens[0]).toMatchObject({ state: "TERMINAL", filledX18: "0", errorCode: "ORDER_REFUSED_2008" });
    expect(BigInt(aOpens.at(-1)!.filledX18)).toBeGreaterThan(0n);
  });
  it("re-prices a non-2008 market refusal (off-tick 2000) and the next post fills, without pausing", async () => {
    const x = fixture(), dispatch = x.connector.dispatch; let refused: string | undefined;
    x.connector.dispatch = async (c, prepared, allowed) => { if (!refused && prepared.postOnly) { refused = prepared.digest; throw new Error("ORDER_REFUSED_2000"); } return dispatch(c, prepared, allowed); };
    await x.init(); await x.step(2);
    expect((await x.current()).groups[0]!.pairs[0]!.state).not.toBe("PAUSED");
    const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    expect(c.groups[0]!.pairs[0]!.rounds[0]!.orders.filter(o => o.role === "A_OPEN").map(o => [o.state, o.filledX18])).toEqual([["TERMINAL", "0"], ["TERMINAL", "100"]]);
  });
  it("sets the round aside at the reprice cap, counts only refusal legs, and ends the pair after a persistent run", async () => {
    const x = fixture(), dispatch = x.connector.dispatch;
    x.connector.dispatch = async (c, prepared, allowed) => { if (prepared.postOnly) throw new Error("ORDER_REFUSED_2008"); return dispatch(c, prepared, allowed); };
    await x.init();
    const c = await x.until(c => c.groups[0]!.pairs[0]!.state === "COMPLETED", 150);
    const pair = c.groups[0]!.pairs[0]!;
    // Ended by the cross-round backstop (NOT paused, NOT the margin "refused repeatedly" path), flat.
    expect(pair.state).toBe("COMPLETED");
    expect(pair.errorCode).toBe("EXPERIMENT_MARKET_UNPRICEABLE");
    expect(x.positions.get(address(1)) ?? 0n).toBe(0n); expect(x.positions.get(address(2)) ?? 0n).toBe(0n);
    // Three rounds in a row set aside, each after EXACTLY the cap of refusal-errorCode legs
    // (one fewer would still be re-pricing, not exiting), each flat with no fills.
    const setAside = pair.rounds.filter(r => r.earlyExitReason === "REPRICE_EXHAUSTED_EXIT");
    expect(setAside).toHaveLength(3);
    for (const r of setAside) {
      const aOpens = r.orders.filter(o => o.role === "A_OPEN");
      expect(aOpens).toHaveLength(REPRICE_ATTEMPTS);
      expect(aOpens.every(o => o.state === "TERMINAL" && o.filledX18 === "0" && o.errorCode === "ORDER_REFUSED_2008")).toBe(true);
    }
  });
  it("ends the pair on a market-disabled (2069) or at-OI (2070) refusal of A's open instead of re-pricing forever", async () => {
    for (const code of ["2069", "2070"]) {
      const x = fixture(), dispatch = x.connector.dispatch;
      x.connector.dispatch = async (c, prepared, allowed) => { if (prepared.postOnly) throw new Error(`ORDER_REFUSED_${code}`); return dispatch(c, prepared, allowed); };
      await x.init();
      const pair = (await x.until(c => c.groups[0]!.pairs[0]!.state === "PAUSED")).groups[0]!.pairs[0]!;
      expect(pair.errorCode).toBe("EXPERIMENT_MARKET_UNAVAILABLE");
      expect(pair.rounds[0]!.orders.filter(o => o.role === "A_OPEN").every(o => o.state === "TERMINAL" && o.filledX18 === "0")).toBe(true);
    }
  });
  it("a 2070 (at open-interest cap) refusal of B's follow closes A at once rather than leaving it unhedged", async () => {
    const x = fixture(), dispatch = x.connector.dispatch, lookup = x.connector.lookup, refused = new Set<string>();
    x.connector.dispatch = async (c, prepared, allowed) => { if (!prepared.postOnly && !prepared.reduceOnly) { refused.add(prepared.digest); throw new Error("ORDER_REFUSED_2070"); } return dispatch(c, prepared, allowed); };
    x.connector.lookup = async (c, o) => refused.has(o.digest) ? { digest: o.digest, identityMatches: true, known: true, terminal: true, filledX18: "0", quoteFilledX18: "0", feePaidX18: "0", observedAt: x.now } : lookup(c, o);
    await x.init();
    const c = await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "COMPLETED");
    const round = c.groups[0]!.pairs[0]!.rounds[0]!;
    expect(round.earlyExitReason).toBe("FOLLOWER_INCOMPLETE_EXIT"); // A closed via the exit path, not left open
    expect(x.positions.get(address(1)) ?? 0n).toBe(0n);
    expect(c.groups[0]!.pairs[0]!.state).not.toBe("PAUSED");
  });
  it("a safe exit during a group step that is still waiting carries that step to its end and completes", async () => {
    const x = fixture({ autoRoll: true, groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }] }, { id: "g2", pairs: [{ id: "p2", a: address(3), b: address(4) }] }] });
    await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING"); x.now = 200000;
    await x.until(c => c.state === "ROLLING" && c.rollovers[0]?.state === "DISPATCHED");
    await x.engine.requestExit(x.config.id);
    const rolls = x.rolls; await x.step(2);
    expect(x.rolls).toBeGreaterThan(rolls); // pending rows are still sent, not only queried
    x.credit = true;
    const c = await x.until(c => c.state === "COMPLETED");
    expect(c.exitRequested).toBe(true); expect(c.rollovers[0]!.state).toBe("CREDITED"); expect(c.activeGroup).toBe(0);
  });
  // Live run 2026-10-25: a Stop left 4 of 20 rows of a group step unsent; after a safe exit the
  // step tried to send them, the live guard refused (the task no longer rolls) and the exit
  // never finished. With a connector that can release unsent rows, an exit sends nothing new.
  it("a safe exit with a connector that releases unsent rows sends nothing new and completes from what was sent", async () => {
    const x = fixture({ autoRoll: true, groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }] }, { id: "g2", pairs: [{ id: "p2", a: address(3), b: address(4) }] }] });
    let abandoned = 0;
    x.connector.abandonUnsentRollover = async (_c, step) => { abandoned++; return { id: step.id, identityMatches: true, state: "CREDITED", reference: step.reference ?? "ref" }; };
    await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING"); x.now = 200000;
    await x.until(c => c.state === "ROLLING" && c.rollovers[0]?.state === "DISPATCHED");
    await x.engine.requestExit(x.config.id);
    const rolls = x.rolls;
    const c = await x.until(c => c.state === "COMPLETED");
    expect(x.rolls).toBe(rolls); expect(abandoned).toBeGreaterThan(0);
    expect(c.exitRequested).toBe(true); expect(c.rollovers[0]!.state).toBe("CREDITED"); expect(c.activeGroup).toBe(0);
  });
  it("a pending group step shows why it waits, and the reason clears once it moves", async () => {
    const x = fixture({ autoRoll: true, groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }] }, { id: "g2", pairs: [{ id: "p2", a: address(3), b: address(4) }] }] });
    const rollover = x.connector.rollover;
    x.connector.rollover = async (c, step, allowed) => ({ ...(await rollover(c, step, allowed)), waitingCode: "PNL_SETTLING" });
    await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING"); x.now = 200000;
    let c = await x.until(c => c.rollovers[0]?.errorCode === "PNL_SETTLING");
    expect(c.state).toBe("ROLLING"); expect(c.groups[0]!.pairs.every(p => p.state !== "PAUSED")).toBe(true);
    x.credit = true; x.connector.rollover = rollover;
    c = await x.until(c => c.activeGroup === 1);
    expect(c.rollovers[0]!.errorCode).toBeUndefined();
  });
  it("a position that is not a whole number of size steps sends no close at all: the pair pauses with both legs still hedged", async () => {
    const x = fixture(), prepare = x.connector.prepare;
    x.connector.prepare = async (c, p, request) => { if (request.role === "A_CLOSE" && !request.postOnly) throw new Error("EXPERIMENT_POSITION_DUST"); return prepare(c, p, request); };
    x.closeFill = 0n;
    await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    x.now = 200000; await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.orders.some(o => o.role === "A_CLOSE") ?? false);
    x.now = 260000;
    const c = await x.until(c => c.groups[0]!.pairs[0]!.state === "PAUSED");
    expect(c.groups[0]!.pairs[0]!.errorCode).toBe("EXPERIMENT_POSITION_DUST");
    expect(c.groups[0]!.pairs[0]!.rounds[0]!.orders.filter(o => o.role === "A_CLOSE" && !o.postOnly)).toHaveLength(0);
    expect(x.positions.get(address(1))).toBe(100n); expect(x.positions.get(address(2))).toBe(-100n);
  });
  it("B's taker close (A already flat) closes the whole size steps and pauses on a remainder under one step", async () => {
    const x = fixture(), prepare = x.connector.prepare;
    x.connector.prepare = async (c, p, request) => {
      if (request.role === "B_CLOSE" && !request.postOnly && request.quantityX18) {
        const whole = BigInt(request.quantityX18) / 30n * 30n;
        if (whole === 0n) throw new Error("EXPERIMENT_POSITION_DUST");
        return prepare(c, p, { ...request, quantityX18: String(whole) });
      }
      return prepare(c, p, request);
    };
    await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    x.now = 200000;
    const c = await x.until(c => c.groups[0]!.pairs[0]!.state === "PAUSED");
    expect(c.groups[0]!.pairs[0]!.errorCode).toBe("EXPERIMENT_POSITION_DUST");
    expect(x.positions.get(address(1))).toBe(0n); expect(x.positions.get(address(2))).toBe(-10n);
  });
  it("ending a task asks the connector's read-only flat check when it has one", async () => {
    const x = fixture(); x.openFill = 0n; await x.init();
    await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.orders.some(o => o.role === "A_OPEN" && o.state === "DISPATCHED") ?? false);
    await x.engine.stop();
    await x.store.update(s => { const o = s.experiments![0]!.groups[0]!.pairs[0]!.rounds[0]!.orders[0]!; o.state = "TERMINAL"; o.cancelState = "CONFIRMED"; o.factKnown = true; });
    let flat = false; x.connector.isFlat = async () => flat;
    await expect(x.engine.closeOut(x.config.id)).rejects.toThrow("EXPERIMENT_OPEN_ROUND_EXIT_FIRST");
    flat = true; await x.engine.closeOut(x.config.id);
    expect((await x.current()).state).toBe("COMPLETED");
  });
  it("a round that holds nothing (all orders final, no net fill) may be ended; one with a position may not", async () => {
    const x = fixture(); x.openFill = 0n; await x.init();
    await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.orders.some(o => o.role === "A_OPEN" && o.state === "DISPATCHED") ?? false);
    await x.engine.stop();
    await x.store.update(s => { const o = s.experiments![0]!.groups[0]!.pairs[0]!.rounds[0]!.orders[0]!; o.state = "TERMINAL"; o.cancelState = "CONFIRMED"; o.factKnown = true; });
    // A fresh account read must also show both wallets flat.
    x.positions.set(address(1), 5n);
    await expect(x.engine.closeOut(x.config.id)).rejects.toThrow("EXPERIMENT_OPEN_ROUND_EXIT_FIRST");
    x.positions.set(address(1), 0n);
    await x.engine.closeOut(x.config.id);
    expect((await x.current()).state).toBe("COMPLETED");
    const y = fixture(); await y.init(); await y.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING"); await y.engine.stop();
    await expect(y.engine.closeOut(y.config.id)).rejects.toThrow("EXPERIMENT_OPEN_ROUND_EXIT_FIRST");
    // Closed by hand on the Nado site: the journal still nets to a position, the account
    // read proves both wallets flat, so the task may be ended and its money collected.
    y.positions.set(address(1), 0n); y.positions.set(address(2), 0n);
    await y.engine.closeOut(y.config.id);
    expect((await y.current()).state).toBe("COMPLETED");
  });
  it("on exit, a claimed step whose batch was never created is dropped, not sent", async () => {
    const x = fixture({ autoRoll: true, groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }] }, { id: "g2", pairs: [{ id: "p2", a: address(3), b: address(4) }] }] });
    await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING"); x.now = 200000;
    await x.until(c => c.groups[0]!.pairs[0]!.state === "COMPLETED");
    await x.engine.stop();
    await x.store.update(s => { const c = s.experiments![0]!; c.rollovers = [{ id: `experiment:${c.id}:roll:0`, fromGroupId: "g1", toGroupId: "g2", state: "DISPATCHED", epoch: c.epoch, createdAt: 1 }]; });
    x.connector.lookupRollover = async (_c, step) => ({ id: step.id, identityMatches: true, state: "PENDING", notStarted: true });
    const rolls = x.rolls;
    await x.engine.requestExit(x.config.id); await x.engine.start(x.config.id);
    const c = await x.until(c => c.state === "COMPLETED");
    expect(x.rolls).toBe(rolls); expect(c.rollovers).toHaveLength(0);
  });
  it("on exit, a group step that was never handed over is dropped, not sent", async () => {
    const x = fixture({ autoRoll: true, groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }] }, { id: "g2", pairs: [{ id: "p2", a: address(3), b: address(4) }] }] });
    await x.init(); await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING"); x.now = 200000;
    await x.until(c => c.groups[0]!.pairs[0]!.state === "COMPLETED");
    await x.engine.stop();
    // A crash between recording the step and claiming it: PREPARED, never sent.
    await x.store.update(s => { const c = s.experiments![0]!; c.rollovers = [{ id: `experiment:${c.id}:roll:0`, fromGroupId: "g1", toGroupId: "g2", state: "PREPARED", epoch: c.epoch, createdAt: 1 }]; });
    const rolls = x.rolls;
    await x.engine.requestExit(x.config.id); await x.engine.start(x.config.id);
    const c = await x.until(c => c.state === "COMPLETED");
    expect(x.rolls).toBe(rolls); expect(c.rollovers).toHaveLength(0);
  });
  it("a pause-and-flatten interrupted by a restart carries on closing, then stops", async () => {
    const x = fixture({ closeMaker: "B", targetNotionalPerWalletX18: "100000" }); await x.init();
    await x.until(c => c.groups[0]!.pairs[0]!.rounds[0]?.state === "HOLDING");
    await x.engine.requestFlatten(x.config.id); await x.engine.stop(x.config.id); // crash before it ran
    expect((await x.current()).flattenRequested).toBe(true);
    await x.engine.reconcile(x.config.id); await x.engine.start(x.config.id); x.now = 20000;
    const c = await x.until(c => c.state === "STOPPED");
    expect(c.flattenRequested).toBeUndefined(); expect(x.positions.get(address(1))).toBe(0n); expect(x.positions.get(address(2))).toBe(0n);
  });
});
describe("1.4.0 unattended: a pair stuck the same way never holds its group for long", () => {
  const two = () => fixture({ maxConcurrency: 2, groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }, { id: "p2", a: address(5), b: address(6) }] }] });
  const run = async (x: ReturnType<typeof fixture>, until: (c: ExperimentCampaign) => boolean) => {
    let c = await x.current();
    for (let i = 0; i < 400 && !until(c); i++) { x.now += 30_000; await x.step(); c = await x.current(); }
    return c;
  };
  it("the only pair left that keeps failing: close-only after 5 minutes, flat so it ends early (its money moves on); the task completes", async () => {
    const x = two(), prepare = x.connector.prepare;
    x.connector.prepare = async (c, p, req) => ({ ...await prepare(c, p, req), ...(p.id === "p1" ? { minimumHedgeQuantityX18: "101" } : {}) });
    await x.init();
    let c = await run(x, c => c.groups[0]!.pairs[1]!.state === "COMPLETED");
    const doneAt = x.now;
    c = await run(x, c => c.state === "COMPLETED");
    const p1 = c.groups[0]!.pairs[0]!;
    expect(p1).toMatchObject({ state: "COMPLETED", errorCode: "EXPERIMENT_PAIR_CLOSED_EARLY", closeOnlyCode: "EXPERIMENT_SIZE_HEDGE_INFEASIBLE" });
    expect(p1.setAsideAt).toBeUndefined();               // flat: not set aside, its money is not held back
    expect(x.now - doneAt).toBeLessThanOrEqual(10 * 60_000); // at most 2 x PAIR_LONELY_MS, not most of an hour
    expect(() => validateDeskOperations(x.store.state)).not.toThrow();
  });
  it("a pair that cannot be made flat is set aside 5 more minutes later; the group still ends", async () => {
    const x = two(); await x.init();
    x.positions.set(address(1), 7n);                      // a position this task did not record
    const c = await run(x, c => c.state === "COMPLETED");
    const p1 = c.groups[0]!.pairs[0]!;
    expect(p1.state).toBe("COMPLETED"); expect(p1.errorCode).toBe("EXPERIMENT_PAIR_SET_ASIDE");
    expect(p1.setAsideAt).toBeDefined(); expect(p1.closeOnlyAt).toBeDefined();
    expect(p1.setAsideAt! - p1.closeOnlyAt!).toBeGreaterThanOrEqual(5 * 60_000);
    expect(() => validateDeskOperations(x.store.state)).not.toThrow();
  });
  it("network-type failures never count toward it", async () => {
    const x = two(), prepare = x.connector.prepare;
    x.connector.prepare = async (c, p, req) => { if (p.id === "p1") throw new Error("EXPERIMENT_NETWORK_UNAVAILABLE"); return prepare(c, p, req); };
    await x.init();
    await run(x, c => c.groups[0]!.pairs[1]!.state === "COMPLETED");
    for (let i = 0; i < 60; i++) { x.now += 30_000; await x.step(); }
    const p1 = (await x.current()).groups[0]!.pairs[0]!;
    expect(p1.closeOnlyAt).toBeUndefined(); expect(p1.setAsideAt).toBeUndefined(); expect(p1.state).not.toBe("COMPLETED");
  });
  it("end-of-task catch-up pass: a pair set aside in group 1 gets another go before the task ends, then the task completes", async () => {
    const x = fixture({ autoRoll: true, maxConcurrency: 2, groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }, { id: "p2", a: address(5), b: address(6) }] },
      { id: "g2", pairs: [{ id: "p3", a: address(7), b: address(8) }, { id: "p4", a: address(9), b: address(10) }] }] });
    x.credit = true; await x.init();
    x.positions.set(address(1), 7n);                          // p1 cannot start: set aside
    let c = await run(x, c => c.activeGroup === 1);
    expect(c.groups[0]!.pairs[0]!.setAsideAt).toBeDefined();
    x.positions.set(address(1), 0n);                          // its cause goes away later
    c = await run(x, c => c.catchUpPassAt !== undefined);
    expect(c.activeGroup).toBe(0); expect(c.groups[0]!.pairs[0]).toMatchObject({ catchUp: true }); expect(c.groups[0]!.pairs[0]!.setAsideAt).toBeUndefined();
    c = await run(x, c => c.state === "COMPLETED");
    const p1 = c.groups[0]!.pairs[0]!;
    expect(p1.state).toBe("COMPLETED"); expect(p1.setAsideAt).toBeUndefined(); expect(p1.rounds.some(r => r.orders.length > 0)).toBe(true);
    expect(c.groups.every(g => g.pairs.every(p => p.state === "COMPLETED"))).toBe(true);
    expect(() => validateDeskOperations(x.store.state)).not.toThrow();
  });
  it("catch-up pass also covers the last group: a pair deferred before the start (deposit not credited) trades at the end", async () => {
    const x = fixture({ maxConcurrency: 2, groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }, { id: "p2", a: address(5), b: address(6) }] }] });
    x.credit = true;
    await x.engine.create(x.config); x.store.validate = false;
    Object.assign(x.store.state.experiments![0]!.groups[0]!.pairs[0]!, { state: "COMPLETED", setAsideAt: 1, setAsideCode: "DEPOSIT_NOT_CREDITED", errorCode: "EXPERIMENT_PAIR_SET_ASIDE" });
    x.store.validate = true; await x.engine.start(x.config.id);
    let c = await run(x, c => c.catchUpPassAt !== undefined);
    expect(c.groups[0]!.pairs[1]!.state).toBe("COMPLETED"); expect(c.groups[0]!.pairs[0]).toMatchObject({ catchUp: true });
    c = await run(x, c => c.state === "COMPLETED");
    const p1 = c.groups[0]!.pairs[0]!;
    expect(p1.setAsideAt).toBeUndefined(); expect(p1.rounds.some(r => r.orders.length > 0)).toBe(true);
    expect(() => validateDeskOperations(x.store.state)).not.toThrow();
  });
  it("the operator can let a set-aside pair of the active group trade again", async () => {
    const x = two(); await x.init(); x.store.validate = false;
    const c = x.store.state.experiments![0]!, p1 = c.groups[0]!.pairs[0]!;
    Object.assign(p1, { state: "COMPLETED", errorCode: "EXPERIMENT_PAIR_SET_ASIDE", setAsideAt: 1, setAsideCode: "X", closeOnlyAt: 1, closeOnlyCode: "X", retryCount: 9 });
    x.store.validate = true;
    await x.engine.rejoinPair(x.config.id, "p1");
    const after = (await x.current()).groups[0]!.pairs[0]!;
    expect(after).toMatchObject({ state: "PAUSED" }); expect([after.setAsideAt, after.closeOnlyAt, after.retryCount, after.errorCode]).toEqual([undefined, undefined, undefined, undefined]);
    await expect(x.engine.rejoinPair(x.config.id, "p2")).rejects.toThrow("EXPERIMENT_PAIR_REJOIN_NOT_ALLOWED");
  });
});
describe("1.4.0 unattended retry rule", () => {
  it("every pause retries; network-type every minute, others 1, 2, 4, 8 then 10 minutes; a notice after 3", async () => {
    const { experimentAutoRetry, experimentRetryDelay, experimentNeedsReview } = await import("./recovery.js");
    for (const code of ["EXPERIMENT_NETWORK_UNAVAILABLE", "SOME_WALLETS_SKIPPED_REVIEW", "EXPERIMENT_UNRECORDED_POSITION_CHANGE", undefined]) expect(experimentAutoRetry(code, 99)).toBe(true);
    expect([1, 2, 3, 4, 5, 9].map(n => experimentRetryDelay("SOME_WALLETS_SKIPPED_REVIEW", n))).toEqual([60000, 120000, 240000, 480000, 600000, 600000]);
    expect(experimentRetryDelay("EXPERIMENT_NETWORK_UNAVAILABLE", 50)).toBe(60000);
    expect(experimentRetryDelay("EXPERIMENT_RATE_LIMITED", 3)).toBe(5000);
    expect(experimentNeedsReview("SOME_WALLETS_SKIPPED_REVIEW", 3)).toBe(true);
    expect(experimentNeedsReview("SOME_WALLETS_SKIPPED_REVIEW", 2)).toBe(false);
    expect(experimentNeedsReview("EXPERIMENT_NETWORK_UNAVAILABLE", 99)).toBe(false);
  });
});

// Audit F02: the catch-up pass lets a pair deferred for an uncredited first deposit back in.
// A deposit with no credit proof is not "no conflict": while its request is still UNKNOWN the
// pair opens nothing; once the deposit is settled it trades.
// [Phase-A deferred] "a pair let back in opens only on a settled deposit": the set-aside +
// catch-up-pass + settled-deposit gate drives on the dropped `funding`/`onboarding` desk
// fields and routed rollover (Phase C). Removed — it guards deferred funding code, not the
// adopted A/B loop, and cannot compile against the trimmed desk document.

// Audit F05: the automatic collection request kept in the task is validated with it.
it("autoCollection: only on a completed live task, with valid times and no other keys", async () => {
  const x = fixture({ mode: "LIVE" }); await x.engine.create(x.config); x.store.validate = false;
  const c = x.store.state.experiments![0]!;
  // Post-split: the autoCollection field is validated DEEPLY by validateExperiments (the
  // funding journal's validateDeskOperations now validates the experiment slot only shallowly).
  const check = (v: unknown, state = "COMPLETED") => { c.state = state as never; (c as any).autoCollection = v; return () => validateExperiments(x.store.state); };
  expect(check({ requestedAt: 5 })).not.toThrow();
  expect(check({ requestedAt: 5, doneAt: 6 })).not.toThrow();
  expect(check({ requestedAt: 5, stoppedAt: 6 })).not.toThrow();
  expect(check({ requestedAt: 5 }, "RUNNING")).toThrow("JOURNAL_DAMAGED");
  expect(check({ requestedAt: 0 })).toThrow("JOURNAL_DAMAGED");
  expect(check({ requestedAt: 5, doneAt: -1 })).toThrow("JOURNAL_DAMAGED");
  expect(check({ requestedAt: 5, other: 1 })).toThrow("JOURNAL_DAMAGED");
  expect(check(null)).toThrow("JOURNAL_DAMAGED");
  expect(check(undefined, "COMPLETED")).not.toThrow();
});
