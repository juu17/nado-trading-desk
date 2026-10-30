// A-2b: the MAX-THROUGHPUT mode (decision #4 default). Guards the TURBO timing profile
// (hold/jitter → ~0, cost gate off), the FREE maxConcurrency dial (decision #5, off the
// intern's 50 cap), and that a round runs end to end with ZERO hold — the opposite of the
// intern's anti-detection 60 s hold. LEGACY/FAST are untouched (the ported suite still pins
// them); this only exercises the new TURBO path.
import { describe, expect, it } from "vitest";
import { emptyOperations, type DeskOperations, type OperationsStore } from "../funding/types.js";
import { slotTiming, roundTimingValid, TURBO_SLOT_MS } from "./timing.js";
import { makeExperimentCampaign, EXPERIMENT_GROUP_MAX_PAIRS } from "./validation.js";
import { ExperimentCoordinator } from "./coordinator.js";
import type { ExperimentCampaign, ExperimentCampaignInput, ExperimentConnector, ExperimentOrder, ExperimentOrderFact, ExperimentOrderRequest, PreparedExperimentOrder } from "./types.js";

const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");

describe("TURBO timing profile", () => {
  it("collapses hold and jitter to ~0 (vs the intern's 60 s hold / 30 s jitter)", () => {
    const t = slotTiming(TURBO_SLOT_MS);
    expect(t.holdMinMs).toBe(0);
    expect(t.holdRandomMs).toBe(0);     // holdMs = 0 + floor(draw*1) = 0 always
    expect(t.openOffsetMs).toBe(1);     // floor(draw*1) = 0 ⇒ no entry jitter, but != 0 (trap guard)
    expect(t.slotMs).toBeGreaterThan(0); // slotStart divides by it
  });
  it("accepts a zero-hold TURBO round and rejects a non-zero hold under TURBO", () => {
    // openAt a multiple of the slot ⇒ openAt % slotMs = 0 < openOffsetMs(1).
    expect(roundTimingValid({ openAt: 5 * TURBO_SLOT_MS, holdMs: 0, slotMs: TURBO_SLOT_MS })).toBe(true);
    expect(roundTimingValid({ openAt: 5 * TURBO_SLOT_MS, holdMs: 1, slotMs: TURBO_SLOT_MS })).toBe(false);
    // A non-boundary openAt (would be jitter) is rejected.
    expect(roundTimingValid({ openAt: 5 * TURBO_SLOT_MS + 1, holdMs: 0, slotMs: TURBO_SLOT_MS })).toBe(false);
  });
});

describe("free maxConcurrency dial", () => {
  const base = (): ExperimentCampaignInput => ({ id: "c", chainId: 763373, mode: "SIMULATION", productId: 2,
    orderNotionalX18: "1000", targetNotionalPerWalletX18: "2000", slippageBps: 10, slotMs: TURBO_SLOT_MS,
    groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }] }] });
  it("admits a concurrency far above the intern's 50 (cohort scale)", () => {
    expect(EXPERIMENT_GROUP_MAX_PAIRS).toBeGreaterThanOrEqual(2500);
    expect(() => makeExperimentCampaign({ ...base(), maxConcurrency: 500 }, 1)).not.toThrow();
    expect(() => makeExperimentCampaign({ ...base(), maxConcurrency: EXPERIMENT_GROUP_MAX_PAIRS }, 1)).not.toThrow();
  });
  it("still rejects a concurrency above the cohort cap", () => {
    expect(() => makeExperimentCampaign({ ...base(), maxConcurrency: EXPERIMENT_GROUP_MAX_PAIRS + 1 }, 1)).toThrow("INVALID_EXPERIMENT_CONFIG");
  });
});

// Minimal in-memory harness: a round under TURBO must open at a slot boundary, hold for 0 ms,
// and complete flat — demonstrating the max-throughput cadence (no 60 s wait).
class Store implements OperationsStore<ExperimentCampaign> {
  state = emptyOperations<ExperimentCampaign>();
  async read() { return structuredClone(this.state); }
  async update<T>(fn: (s: DeskOperations<ExperimentCampaign>) => T) { const copy = structuredClone(this.state), r = fn(copy); this.state = copy; return r; }
}
function turboFixture() {
  const store = new Store(); let now = 0, seq = 1;
  const positions = new Map<string, bigint>(), remote = new Map<string, ExperimentOrderFact>(), requests = new Map<string, ExperimentOrderRequest>(), applied = new Map<string, bigint>();
  const fact = (o: PreparedExperimentOrder, qty: bigint, terminal: boolean): ExperimentOrderFact => ({ digest: o.digest, identityMatches: true, known: true,
    terminal, filledX18: String(qty), quoteFilledX18: String(qty * 10n), feePaidX18: qty ? "1" : "0", observedAt: now });
  const applyPos = (o: ExperimentOrder, f: ExperimentOrderFact) => { const q = BigInt(f.filledX18), prior = applied.get(o.digest) ?? 0n;
    if (q >= prior) { positions.set(o.owner, (positions.get(o.owner) ?? 0n) + (o.side === "BUY" ? 1n : -1n) * (q - prior)); applied.set(o.digest, q); } };
  const connector: ExperimentConnector = {
    preflight: async (_c, p) => ({ complete: true, observedAt: now,
      a: { owner: p.a, positionX18: String(positions.get(p.a) ?? 0n), openDigests: [], equityX18: "100000" },
      b: { owner: p.b, positionX18: String(positions.get(p.b) ?? 0n), openDigests: [], equityX18: "100000" } }),
    prepare: async (c, _p, req) => { requests.set(req.id, req); return { ...req, mode: c.mode, chainId: c.chainId, productId: c.productId,
      digest: "0x" + (seq++).toString(16).padStart(64, "0"), payload: JSON.stringify({ id: req.id }), quantityX18: req.quantityX18 ?? "100", priceX18: "10", nonce: String(seq), expiration: 999999 }; },
    dispatch: async (_c, prepared, allowed) => { if (!allowed()) throw Error("STOPPED"); const req = requests.get(prepared.id)!;
      remote.set(prepared.digest, fact(prepared, req.role === "A_OPEN" ? 100n : BigInt(prepared.quantityX18), !prepared.postOnly)); return prepared.digest; },
    lookup: async (_c, o) => { const f = remote.get(o.digest); if (!f) return { digest: o.digest, identityMatches: false, known: false, terminal: false, filledX18: "0", quoteFilledX18: null, feePaidX18: null, observedAt: now };
      applyPos(o, f); return { ...f, observedAt: now, ...(!f.terminal && f.filledX18 === "0" ? { resting: true as const } : {}) }; },
    cancel: async (_c, o, allowed) => { if (!allowed()) throw Error("STOPPED"); const f = remote.get(o.digest)!; const term = { ...f, terminal: true, observedAt: now }; remote.set(o.digest, term); applyPos(o, term); return term; },
    rollover: async () => { throw Error("EXPERIMENT_ROLLOVER_UNSUPPORTED"); },
    lookupRollover: async () => { throw Error("EXPERIMENT_ROLLOVER_UNSUPPORTED"); },
  };
  // chain:true collapses the intra-round tick latency (density audit): a round completes in ~1–2 passes.
  const engine = new ExperimentCoordinator(store, connector, { now: () => now, random: () => 0, chain: true });
  const config: ExperimentCampaignInput = { id: "turbo", chainId: 763373, mode: "SIMULATION", productId: 2,
    orderNotionalX18: "1000", targetNotionalPerWalletX18: "2000", slippageBps: 10, slotMs: TURBO_SLOT_MS, maxConcurrency: 10,
    groups: [{ id: "g1", pairs: [{ id: "p1", a: address(1), b: address(2) }] }] };
  return { store, config, engine, positions, requests,
    current: async () => (await engine.query(config.id))[0]!,
    set now(v: number) { now = v; }, get now() { return now; },
    init: async () => { await engine.create(config); await engine.start(config.id); },
    step: async (n = 1) => { for (let i = 0; i < n; i++) await engine.tick(config.id); } };
}

describe("TURBO round runs end to end with zero hold", () => {
  it("opens at a slot boundary, holds 0 ms, and completes flat", async () => {
    const x = turboFixture(); await x.init();
    await x.step(1); // first tick draws the round (pair WAITING -> ACTIVE)
    let round = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!;
    expect(round.slotMs).toBe(TURBO_SLOT_MS);
    expect(round.openAt % TURBO_SLOT_MS).toBe(0);  // no jitter
    expect(round.holdMs).toBe(0);                  // no hold
    // Drive to completion WITHOUT advancing the clock: a 0 ms hold and openAt at the slot
    // boundary mean the round opens and completes with no time passing — rounds cycle as fast
    // as ticks fire (max density), not gated by any wait. (Advancing `now` by a full slot per
    // tick would instead keep hitting the window edge; real driver ticks are sub-slot.)
    for (let i = 0; i < 20 && (await x.current()).groups[0]!.pairs[0]!.rounds[0]!.state !== "COMPLETED"; i++) await x.step(1);
    round = (await x.current()).groups[0]!.pairs[0]!.rounds[0]!;
    expect(round.state).toBe("COMPLETED");
    if (round.pairedAt !== undefined) expect(round.holdUntil).toBe(round.pairedAt); // hold window is zero-width
    expect(x.positions.get(address(1))).toBe(0n);
    expect(x.positions.get(address(2))).toBe(0n);
    expect([...x.requests.values()].map(r => [r.role, r.postOnly, r.reduceOnly]))
      .toEqual([["A_OPEN", true, false], ["B_OPEN", false, false], ["A_CLOSE", true, true], ["B_CLOSE", false, true]]);
  });
});
