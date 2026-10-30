// Offline gate for the LIVE benchmark-driver glue. A fake store + fake engine + a manual clock
// (advanced only through the injected sleep) prove the driver deps wire the coordinator/store
// correctly WITHOUT any wall-clock wait or network: setConcurrency mutates the free dial, tick
// advances the engine, rounds reads the live campaign, and advance drives the manual clock.
import { describe, expect, it } from "vitest";
import { emptyOperations, type DeskOperations, type ExperimentCampaign, type OperationsStore } from "@farm/core";
import { BenchmarkDriver } from "./ramp.js";
import { createLiveBenchmarkDriverDeps, buildLiveCampaignInput, type LiveDriverEngine } from "./live-benchmark.js";

class FakeStore implements OperationsStore<ExperimentCampaign> {
  state = emptyOperations<ExperimentCampaign>();
  async read() { return structuredClone(this.state); }
  async update<T>(fn: (s: DeskOperations<ExperimentCampaign>) => T) { const c = structuredClone(this.state); const r = fn(c); this.state = c; return r; }
}

const campaign = (over: Partial<ExperimentCampaign> = {}): ExperimentCampaign => ({
  id: "nado-live-bench", chainId: 763373, mode: "LIVE", productId: 2, orderNotionalX18: "1000",
  targetNotionalPerWalletX18: "100000000000000000000000000", slippageBps: 10, state: "RUNNING", epoch: 0,
  createdAt: 0, updatedAt: 0, activeGroup: 0, maxConcurrency: 1, rollovers: [], exitRequested: false,
  groups: [{ id: "g1", pairs: [{ id: "p0", a: "0xa", b: "0xb", state: "ACTIVE", rounds: [] }] }], wallets: {},
  ...over,
} as ExperimentCampaign);

describe("createLiveBenchmarkDriverDeps — live-driver glue over a fake coordinator/store", () => {
  it("setConcurrency mutates the campaign's free dial through the store", async () => {
    const store = new FakeStore();
    await store.update((s) => { s.experiments = [campaign({ maxConcurrency: 1 })]; });
    const engine: LiveDriverEngine = { tick: () => {}, query: async () => (await store.read()).experiments ?? [] };
    const deps = createLiveBenchmarkDriverDeps({ store, engine, campaignId: "nado-live-bench", tickMs: 10, now: () => 0, sleep: async () => {} });
    await deps.setConcurrency(3);
    expect((await store.read()).experiments?.[0]?.maxConcurrency).toBe(3);
  });

  it("advance drives ONLY the injected clock (no real wait); tick + rounds hit the engine", async () => {
    const store = new FakeStore();
    await store.update((s) => { s.experiments = [campaign()]; });
    let ticks = 0;
    let t = 0;
    const engine: LiveDriverEngine = { tick: () => { ticks++; }, query: async () => (await store.read()).experiments ?? [] };
    const deps = createLiveBenchmarkDriverDeps({ store, engine, campaignId: "nado-live-bench", tickMs: 10, now: () => t, sleep: async (ms) => { t += ms; } });
    const driver = new BenchmarkDriver(deps);
    const started = Date.now();
    const { n, summary } = await driver.runLevel({ atMs: 0, n: 1, holdMs: 100 });
    expect(Date.now() - started).toBeLessThan(1000);   // no real wall-clock wait — the clock is faked
    expect(n).toBe(1);
    expect(ticks).toBe(10);                              // holdMs 100 / tickMs 10 = 10 ticks
    expect(summary.windowMs).toBe(100);                  // window-anchored summary
    expect((await store.read()).experiments?.[0]?.maxConcurrency).toBe(1);
  });

  it("rounds() flattens groups → pairs → rounds from the live campaign", async () => {
    const store = new FakeStore();
    const c = campaign();
    (c.groups[0]!.pairs[0] as { rounds: unknown[] }).rounds = [{ id: "r1", number: 1, orders: [] }, { id: "r2", number: 2, orders: [] }] as never;
    await store.update((s) => { s.experiments = [c]; });
    const engine: LiveDriverEngine = { tick: () => {}, query: async () => (await store.read()).experiments ?? [] };
    const deps = createLiveBenchmarkDriverDeps({ store, engine, campaignId: "nado-live-bench", tickMs: 10 });
    const rounds = await deps.rounds();
    expect(rounds.map((r) => r.id)).toEqual(["r1", "r2"]);
  });
});

describe("buildLiveCampaignInput — the locked single-pair self-cross campaign", () => {
  it("builds a selfCross/closeMaker-B/TURBO, effectively-uncapped single pair on the free dial", () => {
    const c = buildLiveCampaignInput({ chainId: 763373, productId: 145, a: "0xa", b: "0xb", orderNotionalX18: "100000000000000000000", slotMs: 1000, maxConcurrency: 1 });
    expect(c.selfCross).toBe(true);
    expect(c.closeMaker).toBe("B");
    expect(c.mode).toBe("LIVE");
    expect(c.maxConcurrency).toBe(1);
    expect(c.groups[0]!.pairs).toHaveLength(1);
    expect(c.groups[0]!.pairs[0]).toMatchObject({ a: "0xa", b: "0xb" });
    expect(BigInt(c.targetNotionalPerWalletX18)).toBeGreaterThan(10n ** 24n); // effectively uncapped → pair keeps cycling
  });
});
