// =============================================================================
// @farm/loadgen · live-benchmark — wire the (already-tested) BenchmarkDriver to a LIVE run:
// the SAME driver that runs the offline monkey Flow (benchmark-flow.test.ts), but with its
// clock seam backed by the WALL clock (advance = real wait) and its engine seams backed by the
// real ExperimentCoordinator + store. This file is the thin, market-AGNOSTIC glue + the N=1
// self-cross campaign builder; it is unit-tested offline with a fake store/engine (no network).
// The live stack (keyless EngineClient / gateway / A-5 fill source / wative signers) and the
// actual sustained run live in the NADO_LIVE-gated runner, which calls this glue.
// =============================================================================
import type { ExperimentCampaign, ExperimentCampaignInput, ExperimentRound, ExperimentSide, OperationsStore } from "@farm/core";
import type { BenchmarkDriverDeps } from "./ramp.js";

/** The slice of the coordinator the driver drives (ExperimentCoordinator satisfies it). */
export interface LiveDriverEngine {
  tick(campaignId: string): Promise<unknown> | unknown;
  query(campaignId: string): Promise<readonly ExperimentCampaign[]> | readonly ExperimentCampaign[];
}

export interface LiveBenchmarkDriverOpts {
  store: OperationsStore<ExperimentCampaign>;
  engine: LiveDriverEngine;
  campaignId: string;
  /** Clock advance per tick (ms, > 0) — sub-slot so a round's FSM gets several ticks per slot. */
  tickMs: number;
  /** Defaults to Date.now (live). Injected in tests. */
  now?: () => number;
  /** Defaults to a real setTimeout wait (live). Injected in tests. The KEY live vs offline
   *  difference: here `advance(ms)` actually WAITS ms of wall-clock (vs a test clock's instant
   *  jump), so the driver paces the coordinator against real sequencer/latency timing. */
  sleep?: (ms: number) => Promise<void>;
}

const flattenRounds = (campaigns: readonly ExperimentCampaign[]): readonly ExperimentRound[] =>
  campaigns[0]?.groups.flatMap((g) => g.pairs.flatMap((p) => p.rounds)) ?? [];

/**
 * Build the BenchmarkDriverDeps for a LIVE run: setConcurrency mutates the campaign's free dial
 * through the store; tick advances the real coordinator; rounds reads the live campaign's rounds;
 * advance WAITS wall-clock. Everything is injected so the orchestration is unit-tested offline.
 */
export function createLiveBenchmarkDriverDeps(opts: LiveBenchmarkDriverOpts): BenchmarkDriverDeps {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    setConcurrency: (n) => opts.store.update((s) => {
      const c = s.experiments?.find((x) => x.id === opts.campaignId);
      if (c) c.maxConcurrency = n;
    }),
    tick: async () => { await opts.engine.tick(opts.campaignId); },
    rounds: async () => flattenRounds(await opts.engine.query(opts.campaignId)),
    now,
    advance: (ms) => sleep(ms),
    tickMs: opts.tickMs,
  };
}

export interface LiveCampaignOpts {
  id?: string;
  chainId: number;
  productId: number;
  /** Canonical (lowercase) owners of the single pair. */
  a: string;
  b: string;
  orderNotionalX18: string;
  slotMs: number;              // TURBO_SLOT_MS for max round-rate
  maxConcurrency?: number;     // N; 1 for this leg
  slippageBps?: number;
  /** Effectively uncapped so the pair keeps cycling rounds for the whole measurement window. */
  targetNotionalPerWalletX18?: string;
  side?: ExperimentSide;       // omitted → the coordinator draws BUY/SELL per round
}

/** The locked single-pair self-cross benchmark campaign (decisions #2/#4/#5): selfCross,
 *  closeMaker "B", TURBO slot, free dial, effectively-uncapped target so the pair cycles. */
export function buildLiveCampaignInput(opts: LiveCampaignOpts): ExperimentCampaignInput {
  return {
    id: opts.id ?? "nado-live-bench",
    chainId: opts.chainId,
    mode: "LIVE",
    productId: opts.productId,
    orderNotionalX18: opts.orderNotionalX18,
    targetNotionalPerWalletX18: opts.targetNotionalPerWalletX18 ?? "100000000000000000000000000",
    slippageBps: opts.slippageBps ?? 10,
    slotMs: opts.slotMs,
    selfCross: true,
    closeMaker: "B",
    maxConcurrency: opts.maxConcurrency ?? 1,
    groups: [{ id: "g1", pairs: [{ id: "p0", a: opts.a, b: opts.b }] }],
  } as ExperimentCampaignInput;
}
