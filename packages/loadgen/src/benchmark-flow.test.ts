// =============================================================================
// @farm/loadgen · benchmark-flow — the OFFLINE monkey runner (Phase B-4). The repo-native,
// no-browser equivalent of the intern's qa-experiments.mjs (NOT its Windows/E:-drive/PowerShell
// rig): it wires the REAL A/B coordinator + the ramp driver + the capacity metrics end to end
// against a fake single-market CLOB, sweeps the free maxConcurrency dial through a ramp, and
// proves the whole pipeline produces a sane fills/sec + latency curve vs N. A live run would
// swap the fake connector for the testnet gateway and the test clock for the wall clock (and, if
// driving the console UI, ~/.claude/toolchains/Playwright); the driver/metrics are unchanged.
//
// The fake is a minimal CLOB (post-only rests, a taker crosses) that is PAIR-AWARE: a taker
// crosses only its OWN pair-mate's resting maker (the intended self-cross, decision #2), so the
// Flow exercises the driver/metrics pipeline without the cross-pair collisions that B-2's policy
// (self-trade.ts, separately tested) handles. One market, selfCross + closeMaker:"B" + TURBO —
// the locked benchmark shape (decisions #2/#4/#5).
// =============================================================================
import { describe, expect, it } from "vitest";
import { emptyOperations, type DeskOperations, type OperationsStore } from "@farm/core";
import {
  ExperimentCoordinator, TURBO_SLOT_MS,
  type ExperimentCampaign, type ExperimentCampaignInput, type ExperimentConnector,
  type ExperimentOrderFact, type ExperimentOrderRequest, type ExperimentRound,
} from "@farm/core";
import { BenchmarkDriver, type RampProfile } from "./ramp.js";

const address = (n: number): string => "0x" + n.toString(16).padStart(40, "0");

class Store implements OperationsStore<ExperimentCampaign> {
  state = emptyOperations<ExperimentCampaign>();
  async read() { return structuredClone(this.state); }
  async update<T>(fn: (s: DeskOperations<ExperimentCampaign>) => T) { const copy = structuredClone(this.state), r = fn(copy); this.state = copy; return r; }
}

/** Build the offline harness: a pair-aware single-market CLOB fake + the real coordinator + an
 *  N-pair selfCross/closeMaker/TURBO campaign. `pairs` wallets A/B are 1..2N. */
function buildFakeBenchmark(pairs: number) {
  const store = new Store();
  let now = 0, seq = 1;
  const positions = new Map<string, bigint>();
  // owner -> pairId, so a taker crosses only its OWN pair-mate's resting maker (intended cross).
  const pairOf = new Map<string, string>();
  type Rec = { owner: string; pairId: string; side: "BUY" | "SELL"; qty: bigint; filled: bigint; postOnly: boolean; resting: boolean; terminal: boolean; productId: number };
  const orders = new Map<string, Rec>();
  const requests = new Map<string, ExperimentOrderRequest>();
  const move = (owner: string, side: "BUY" | "SELL", qty: bigint) => positions.set(owner, (positions.get(owner) ?? 0n) + (side === "BUY" ? 1n : -1n) * qty);
  const factOf = (digest: string): ExperimentOrderFact => {
    const o = orders.get(digest)!;
    return { digest, identityMatches: true, known: true, terminal: o.terminal, filledX18: String(o.filled),
      quoteFilledX18: String(o.filled * 10n), feePaidX18: o.filled > 0n ? "1" : "0", observedAt: now,
      ...(o.resting && o.filled < o.qty ? { resting: true as const } : {}) };
  };
  const config: ExperimentCampaignInput = {
    id: "bench", chainId: 763373, mode: "SIMULATION", productId: 2,
    orderNotionalX18: "1000", targetNotionalPerWalletX18: "100000000000000000000000000", // effectively uncapped: pairs keep cycling
    slippageBps: 10, slotMs: TURBO_SLOT_MS, selfCross: true, closeMaker: "B", maxConcurrency: 1,
    groups: [{ id: "g1", pairs: Array.from({ length: pairs }, (_, i) => ({ id: `p${i}`, a: address(2 * i + 1), b: address(2 * i + 2) })) }],
  };
  for (const p of config.groups[0]!.pairs) { pairOf.set(p.a.toLowerCase(), p.id); pairOf.set(p.b.toLowerCase(), p.id); }

  const connector: ExperimentConnector = {
    preflight: async (_c, p) => {
      const snap = (owner: string) => ({ owner, positionX18: String(positions.get(owner) ?? 0n),
        openDigests: [...orders.entries()].filter(([, o]) => o.owner === owner && o.resting && !o.terminal).map(([d]) => d), equityX18: "100000" });
      return { complete: true, observedAt: now, a: snap(p.a), b: snap(p.b) };
    },
    prepare: async (c, _pair, request) => {
      requests.set(request.id, request);
      return { ...request, mode: c.mode, chainId: c.chainId, productId: c.productId, digest: "0x" + (seq++).toString(16).padStart(64, "0"),
        payload: JSON.stringify({ id: request.id }), quantityX18: request.quantityX18 ?? "100", priceX18: "10", nonce: String(seq), expiration: 999999 };
    },
    dispatch: async (_c, prepared, allowed) => {
      if (!allowed()) throw Error("STOPPED");
      const pairId = pairOf.get(prepared.owner.toLowerCase()) ?? "?";
      const rec: Rec = { owner: prepared.owner, pairId, side: prepared.side as "BUY" | "SELL", qty: BigInt(prepared.quantityX18),
        filled: 0n, postOnly: prepared.postOnly, resting: prepared.postOnly, terminal: false, productId: prepared.productId };
      orders.set(prepared.digest, rec);
      if (!prepared.postOnly) {
        // Taker: cross only the SAME PAIR's oldest resting opposite-side maker (intended self-cross).
        let remaining = rec.qty;
        for (const maker of orders.values()) {
          if (remaining === 0n) break;
          if (!maker.resting || maker.terminal || maker.productId !== rec.productId || maker.side === rec.side || maker.pairId !== rec.pairId) continue;
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
    lookup: async (_c, o) => orders.has(o.digest) ? factOf(o.digest)
      : { digest: o.digest, identityMatches: false, known: false, terminal: false, filledX18: "0", quoteFilledX18: null, feePaidX18: null, observedAt: now },
    cancel: async (_c, o, allowed) => { if (!allowed()) throw Error("STOPPED"); const rec = orders.get(o.digest); if (rec) { rec.resting = false; rec.terminal = true; } return factOf(o.digest); },
    rollover: async () => { throw Error("EXPERIMENT_ROLLOVER_UNSUPPORTED"); },
    lookupRollover: async () => { throw Error("EXPERIMENT_ROLLOVER_UNSUPPORTED"); },
  };

  const engine = new ExperimentCoordinator(store, connector, { now: () => now, random: () => 0, chain: true });
  return {
    store, engine, config, positions,
    setNow: (v: number) => { now = v; },
    getNow: () => now,
    allRounds: async (): Promise<ExperimentRound[]> =>
      (await engine.query(config.id))[0]?.groups.flatMap((g) => g.pairs.flatMap((p) => p.rounds)) ?? [],
    setConcurrency: (n: number) => store.update((s) => { const c = s.experiments?.find((x) => x.id === config.id); if (c) c.maxConcurrency = n; }),
    init: async () => { await engine.create(config); await engine.start(config.id); },
  };
}

/** Run the full ramp → coordinator → metrics pipeline once. Exported shape mirrors a live runner.
 *  tickMs is sub-slot (≈20 ticks per TURBO slot) so a round's FSM gets the several ticks it needs
 *  to complete within a slot (chain:true collapses intra-round latency) before the next slot opens
 *  a fresh round — advancing a whole slot per tick would strand rounds mid-FSM. */
async function runBenchmarkFlow(pairs: number, profile: RampProfile, tickMs = Math.max(1, Math.floor(TURBO_SLOT_MS / 20))) {
  const h = buildFakeBenchmark(pairs);
  await h.init();
  const driver = new BenchmarkDriver({
    setConcurrency: h.setConcurrency, tick: async () => { await h.engine.tick(h.config.id); }, rounds: h.allRounds,
    now: h.getNow, advance: (ms) => h.setNow(h.getNow() + ms), tickMs,
  });
  const run = await driver.runCurve(profile);
  return { run, positions: h.positions };
}

describe("benchmark-flow — the offline capacity monkey runner (full pipeline)", () => {
  it("sweeps a step ramp over N pairs and produces a sane fills/sec + latency curve", async () => {
    const profile: RampProfile = { shape: "step", startN: 1, peakN: 4, levels: 4, holdMs: 3 * TURBO_SLOT_MS };
    const { run, positions } = await runBenchmarkFlow(4, profile);

    // A curve point per concurrency level, ascending N.
    expect(run.curve.map((c) => c.n)).toEqual([1, 2, 3, 4]);
    // The pipeline actually produced matched fills (the self-cross rounds completed and were counted).
    const totalMatches = run.points.reduce((n, p) => n + p.summary.matchedFills, 0);
    expect(totalMatches).toBeGreaterThan(0);
    // Each level's rate is window-anchored (honest sustained rate, not a burst rate).
    expect(run.points.every((p) => p.summary.windowed && p.summary.windowMs === profile.holdMs)).toBe(true);
    // fills/sec rises strictly with N — the free dial drives density.
    const fps = run.curve.map((c) => c.fillsPerSec);
    for (let i = 1; i < fps.length; i++) expect(fps[i]!).toBeGreaterThan(fps[i - 1]!);
    // UNBIASED attribution: the fake has no capacity ceiling, so per-pair throughput is constant
    // (a linear curve). The prior creation-id attribution undercounted continuing pairs, making
    // the per-pair rate decline with N (a fake knee). Guard that it stays flat (±15%).
    const perPair = run.curve.map((c) => c.fillsPerSec / c.n);
    const lo = Math.min(...perPair), hi = Math.max(...perPair);
    expect(hi / lo).toBeLessThan(1.15);
    // The cohort ends flat (every self-cross round closed both legs): no stranded position.
    expect([...positions.values()].every((p) => p === 0n)).toBe(true);

    // Human-readable curve for the operator log (the runner's output).
    for (const c of run.curve) {
      // eslint-disable-next-line no-console
      console.log(`N=${c.n}\tfills=${c.matchedFills}\tfills/sec=${c.fillsPerSec.toFixed(2)}\tp50=${c.p50Ms}ms\tp99=${c.p99Ms}ms`);
    }
  });

  it("runs a spike ramp (admission burst) — the burst's pairs persist after the dial is lowered", async () => {
    const profile: RampProfile = { shape: "spike", startN: 1, peakN: 4, holdMs: 3 * TURBO_SLOT_MS, spikeHoldMs: 3 * TURBO_SLOT_MS };
    const { run } = await runBenchmarkFlow(4, profile);
    expect(run.setpoints.map((s) => s.n)).toEqual([1, 4, 1]);
    expect(run.points).toHaveLength(3);
    // The spike admits more pairs: the peak level saw strictly more matched fills than the baseline.
    expect(run.points[1]!.summary.matchedFills).toBeGreaterThan(run.points[0]!.summary.matchedFills);
    // The dial is an admission ceiling with NO preemption of active pairs, so the down-leg keeps
    // running the burst's pairs — it stays at the peak throughput, it does NOT fall back to the
    // baseline (a true concurrency-down needs coordinator preemption; see ramp.ts). Guard that:
    // the post-burst level's throughput is well above the pre-burst baseline, not a recovery to it.
    expect(run.points[2]!.summary.matchedFills).toBeGreaterThan(run.points[0]!.summary.matchedFills * 2);
  });
});
