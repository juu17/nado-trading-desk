// =============================================================================
// LEG 3 — the LIVE N=1 sustained self-cross run (single-pair throughput baseline). GATED on
// NADO_LIVE, so the offline suite SKIPS it. Run ONLY on an explicit go, after the market is
// confirmed:
//
//   NADO_LIVE=1 pnpm exec vitest run packages/loadgen/src/testnet-sustained.test.ts
//
// It assembles the REAL ExperimentCoordinator + the live NadoExperimentConnector (via
// assembleLiveConnector) + the live BenchmarkDriver (createLiveBenchmarkDriverDeps, wall clock),
// and drives ONE pair at max round-rate (TURBO, free dial N=1) on a FLAT (A & B hold no
// pre-existing position) wide-spread (>=2 tick) perp for a sustained window. It reports the
// single-pair matched fills/sec + p50/p99 fill-confirm latency + the fills/sec timeseries, and
// proves the pair ends flat+settled. A double-place / UNKNOWN / fatal is run-terminating (checked
// every tick → abort). Honest framing: this is ONE pair's single-egress throughput, NOT the
// engine's concurrent capacity (that is the multi-pair curve, a later leg). Testnet only; keys
// stay in custody; the write budget is the LIVE-calibrated 8/s (far above a single pair's rate).
// =============================================================================
import { describe, it, expect } from "vitest";
import { EngineClient } from "@nadohq/engine-client";
import {
  CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS, ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS,
  NADO_DEPLOYMENTS, subaccountToHex,
} from "@nadohq/client";
import { writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Custody, SharedReadBudget, MeteredTransport, ClockSync, InMemoryOperationsStore,
  ExperimentCoordinator, TURBO_SLOT_MS, assertExperimentOrderAdmission,
  type ExperimentCampaign,
} from "@farm/core";
import {
  createMultiWalletNadoGateway, createNadoFillReads, FillAccumulator, subscribeFills,
  nadoMarketSizing, ENGINE_ORDER_NOT_FOUND_CODE, type NadoGateway,
} from "@farm/adapter-nado";
import type { MarketId } from "@farm/adapter-api";
import { createLiveOrderFillSource } from "./live-order-fill.js";
import { assembleLiveConnector, registerNadoWriteBuckets, canonicalOwner } from "./live-connector.js";
import { createLiveEquitySource, decimalToX18 } from "./live-equity.js";
import { createLiveBenchmarkDriverDeps, buildLiveCampaignInput } from "./live-benchmark.js";
import { BenchmarkDriver } from "./ramp.js";
import { RunMetrics } from "./metrics.js";
import { assertCohortFlatSettled } from "./cohort-settle.js";

const LIVE = process.env.NADO_LIVE === "1" || process.env.NADO_LIVE === "true";
const CHAIN_ID = 763373;
const ENV = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID]!;
const engineUrl = ENGINE_CLIENT_ENDPOINTS[ENV];
const wsUrl = ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS[ENV];
const DEPLOY = NADO_DEPLOYMENTS[ENV];
const SUBACCT = "default";
const WINDOW_MS = Number(process.env.AB_WINDOW_MS ?? 150_000); // ~2.5 min; >=60s stable
// Candidates = TRADABLE 24/7 CRYPTO perps (A & B2 are flat on all of them). Equity perps are
// TRADING_STOPPED off-hours (weekends) — excluded. Tradability live-probed 2026-10-30
// (scripts/tradable-probe.mjs): FARTCOIN, ASTER, DOGE, LTC, UNI, JUP, ENA. BTC(2)/WETH(3) excluded.
const CANDIDATES = (process.env.AB_PRODUCT_ID ? [Number(process.env.AB_PRODUCT_ID)] : [22, 48, 52, 76, 46, 86, 72]);
// Deeper post-only maker: rest MAKER_HEADROOM ticks inside the opposite touch so it survives a
// tick-or-two tighten between book-read and submit (the ~98% 2008 at best±1t). The maker is
// clamped to still improve its near touch, so the self-cross taker crosses A — BUT only if the
// spread is wider than the headroom, so the market selection requires spread >= HEADROOM + 1.
const MAKER_HEADROOM = Math.max(1, Number(process.env.NADO_MAKER_HEADROOM_TICKS ?? 2));
const SPREAD_FLOOR = MAKER_HEADROOM + 1;

const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const fx = (v: unknown): number => (v == null ? NaN : typeof v === "object" && (v as { toFixed?: unknown }).toFixed ? Number((v as { toFixed: () => string }).toFixed()) : Number(v));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log: string[] = [];
const say = (s: string) => { console.log(s); log.push(s); };

describe.skipIf(!LIVE)("LEG 3 — live N=1 sustained self-cross (single-pair baseline)", () => {
  it("drives one pair at max round-rate for a sustained window and reports fills/sec + latency", async () => {
    await import("wative-core/node");
    const results: Record<string, unknown> = { chainId: CHAIN_ID, startedAt: new Date().toISOString(), windowMs: WINDOW_MS };
    const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-testnet", "credentials.json"), "utf8"));
    // Cohort = {A (maker, index 0), the ACTIVE taker}. The active taker is B2 (index 2, fresh +
    // flat); B (index 1) is PARKED holding BTC inventory and is OUT of the cohort.
    const takerRole = cred.activeTaker ?? "B2";
    const takerEntry = cred.wallets?.find((w: { role: string }) => w.role === takerRole) ?? cred.wallets?.find((w: { role: string }) => w.role === "B");
    const takerIndex: number = takerEntry?.index ?? 1;
    const A = canonicalOwner((cred.wallets?.find((w: { role: string }) => w.role === "A") ?? { address: cred.address }).address);
    const B = canonicalOwner(takerEntry.address);

    // ---- custody signers (keys stay in the encrypted workspace) -----------------------------
    const custody = await Custody.open({ path: cred.workspacePath, password: cred.password });
    const cohort = await custody.firstCohort(cred.password);
    const signerA = custody.signerFor(cohort, 0, CHAIN_ID);
    const signerB = custody.signerFor(cohort, takerIndex, CHAIN_ID); // the active taker (B2 = index 2)
    say(`  cohort: A(maker)=${A} taker ${takerRole}(index ${takerIndex})=${B}`);

    // ---- live stack: keyless engine, 28 read budget + calibrated write buckets, gateway, A-5 ---
    const engine = new EngineClient({ url: engineUrl });
    const budget = new SharedReadBudget();
    registerNadoWriteBuckets(budget.rateLimiter);
    const transport = new MeteredTransport({ limiter: budget.rateLimiter, headers: { "accept-encoding": "gzip, deflate" } });
    const readShim = { acquire: async (_bucket: string, weight = 1) => budget.acquire({ weight }) };
    const allMarkets: any[] = await engine.getAllMarkets();
    const symbols: Record<string, any> = (await engine.getSymbols({})).symbols ?? {};
    const symByPid = new Map<number, any>(Object.values(symbols).map((s: any) => [s.productId, s]));

    // pick a FLAT wide-spread market (poll for a >=2-tick window)
    let PID = 0, symbol = "", tick = 0;
    for (let attempt = 0; attempt < Number(process.env.AB_SPREAD_ATTEMPTS ?? 45) && !PID; attempt++) {
      let best = { spreadT: 0, pid: 0, tick: 0, symbol: "" };
      for (const pid of CANDIDATES) {
        const sy = symByPid.get(pid); if (!sy) continue;
        const t = fx(sy.priceIncrement);
        const liq: any = await engine.getMarketLiquidity({ productId: pid, depth: 1 }).catch(() => ({ bids: [], asks: [] }));
        const bb = fx(liq.bids?.[0]?.price), ba = fx(liq.asks?.[0]?.price);
        const spreadT = (bb > 0 && ba > 0 && t > 0) ? Math.round((ba - bb) / t) : 0;
        if (spreadT > best.spreadT && ba > 0) best = { spreadT, pid, tick: t, symbol: sy.symbol };
      }
      // Need a spread wider than the maker headroom (SPREAD_FLOOR = headroom + 1) so the deeper
      // maker rests with headroom AND still improves its near touch for a clean A↔B self-cross.
      if (best.spreadT >= SPREAD_FLOOR) { PID = best.pid; tick = best.tick; symbol = best.symbol; say(`  selected FLAT market pid=${PID} ${symbol} spread=${best.spreadT}t (need >=${SPREAD_FLOOR}t for headroom ${MAKER_HEADROOM}, attempt ${attempt + 1})`); break; }
      if (attempt === 0) say(`  widest flat-market spread ${best.spreadT}t (<${SPREAD_FLOOR}) — polling for a >=${SPREAD_FLOOR}-tick window (maker headroom ${MAKER_HEADROOM})…`);
      await sleep(1800);
    }
    if (!PID) throw new Error(`no flat market with spread >=${SPREAD_FLOOR} ticks (maker headroom ${MAKER_HEADROOM}+1) appeared in the wait window — this testnet book cannot rest a top-of-book self-cross maker (venue ceiling)`);
    const marketId = `nado:perp:${symbol}` as MarketId;
    const productIds = { [marketId]: PID } as Record<MarketId, number>;
    const sym = symByPid.get(PID)!;
    const sizing = nadoMarketSizing(String(fx(sym.priceIncrement)), BigInt(sym.sizeIncrement.toFixed(0)), BigInt(sym.minSize.toFixed(0)));
    // Min-notional sizing (safety): the per-order notional is the market's LIVE min order notional
    // (sizing.minNotional, the USDT0 floor read from getSymbols), not a hardcoded 100e18 — the
    // smallest allowed order is the smallest stray exposure. The connector/clampOrderSize already
    // lifts a below-min size to this floor; sizing it here makes the intent explicit + per-market.
    const orderNotionalX18 = decimalToX18(sizing.minNotional).toString();
    results.market = { productId: PID, symbol, tick, sizing, orderNotionalX18 };

    const gateway = createMultiWalletNadoGateway({ engine: engine as never, transport, limiter: readShim, engineUrl, chainId: CHAIN_ID, endpoint: DEPLOY.endpoint, markets: [], productIds });
    // DIAGNOSTIC: surface the RAW submitOrder error (the relay classifies + rethrows, hiding it).
    let rawSubmitErr = "";
    const loggedGateway = {
      owners: () => gateway.owners(),
      forOwner: (o: string) => new Proxy(gateway.forOwner(o), {
        get: (t: any, p: string) => p === "submitOrder"
          ? async (s: unknown) => { try { return await t.submitOrder(s); } catch (e: any) { if (!rawSubmitErr) { rawSubmitErr = J({ msg: e?.message, code: e?.code, category: e?.category, raw: e?.raw, name: e?.name }); say(`  [submit-raw] ${rawSubmitErr.slice(0, 400)}`); } throw e; } }
          : t[p],
      }),
    } as unknown as typeof gateway;

    // keyless public fill stream → accumulator (A-5 wake + per-fill feed)
    const acc = new FillAccumulator();
    const senderA = subaccountToHex({ subaccountOwner: A, subaccountName: SUBACCT });
    const senderB = subaccountToHex({ subaccountOwner: B, subaccountName: SUBACCT });
    const WSImpl: any = (globalThis as any).WebSocket;
    const ws: any = new WSImpl(wsUrl);
    await Promise.race([new Promise<void>((res) => { ws.onopen = () => res(); }), sleep(8000)]);
    const socket = { send: (d: string) => ws.send(d), addEventListener: (t: string, l: (ev: { data?: unknown }) => void) => ws.addEventListener(t, l), readyState: ws.readyState as number };
    const disposeFills = subscribeFills(socket, [senderA, senderB], acc);
    const reads = createNadoFillReads({
      engine: engine as never, accumulator: acc, acquire: (u) => budget.acquire({ urgent: u }),
      isOrderNotFound: (err) => { const m = (err as { message?: string })?.message ?? ""; const lead = /^\s*(\d{3,4})\s*:/.exec(m); return lead ? Number(lead[1]) === ENGINE_ORDER_NOT_FOUND_CODE : /could not be found|not found/i.test(m); },
    });
    const orderFill = createLiveOrderFillSource(reads);

    // ---- real coordinator + live connector over ONE shared store ----------------------------
    const store = new InMemoryOperationsStore<ExperimentCampaign>();
    // Real per-wallet equity (getBalances → USDT0 collateral) so the coordinator enforces the
    // per-wallet maxLoss on live equity. Testnet: wired but harmless (maxLoss unset below). The
    // read goes through the real gateway (not the submit-logging proxy).
    const equityFor = createLiveEquitySource((o) => gateway.forOwner(o) as NadoGateway);
    const live = assembleLiveConnector({
      chainId: CHAIN_ID, endpoint: DEPLOY.endpoint, gateway: loggedGateway, signers: [signerA, signerB],
      sizingFor: () => sizing, marketIdFor: () => marketId, clock: () => new ClockSync().now(),
      orderFill, equityFor, admit: assertExperimentOrderAdmission, store, makerHeadroomTicks: MAKER_HEADROOM,
    });
    say(`  deeper maker: headroom ${MAKER_HEADROOM} tick(s) from the opposite touch (post-only rests through a tighten)`);
    // DIAGNOSTIC: surface swallowed per-pair lane errors (Promise.allSettled hides them) + events.
    let firstConnErr = "";
    const base = live.connector;
    const wrapErr = (name: string, fn: (...a: any[]) => Promise<any>) => (...a: any[]) => fn(...a).catch((e: any) => { if (!firstConnErr) { firstConnErr = `${name}: ${e?.message}`; say(`  [conn-throw] ${firstConnErr} | detail=${J({ name: e?.name, code: e?.code, nadoCode: e?.nadoCode, httpStatus: e?.httpStatus, raw: e?.raw, keys: Object.keys(e ?? {}) }).slice(0, 400)}`); } throw e; });
    const dbg = {
      preflight: wrapErr("preflight", (...a: any[]) => base.preflight(a[0], a[1])),
      prepare: wrapErr("prepare", (...a: any[]) => base.prepare(a[0], a[1], a[2])),
      dispatch: wrapErr("dispatch", (...a: any[]) => base.dispatch(a[0], a[1], a[2])),
      lookup: (...a: any[]) => base.lookup(a[0], a[1]), cancel: (...a: any[]) => base.cancel(a[0], a[1], a[2]),
      rollover: () => base.rollover(), lookupRollover: (...a: any[]) => base.lookupRollover(a[0], a[1]),
      livePositions: (c: any) => base.livePositions(c), fillHints: (c: any) => base.fillHints(c),
    } as unknown as typeof base;
    const coordinator = new ExperimentCoordinator(store, dbg, { now: Date.now, random: Math.random, chain: true,
      onEvent: (e: { level: string; event: string; data?: unknown }) => { if (e.level !== "info" || /start|order_send|set_aside|flatten/.test(e.event)) say(`  [evt] ${e.level} ${e.event}${e.data ? " " + J(e.data).slice(0, 140) : ""}`); } });
    const campaign = buildLiveCampaignInput({ chainId: CHAIN_ID, productId: PID, a: A, b: B, orderNotionalX18, slotMs: TURBO_SLOT_MS, maxConcurrency: 1 });
    say(`  min-notional sizing: orderNotional=${orderNotionalX18} x18 (live minNotional ${sizing.minNotional} USDT0)`);

    // baselines (expect flat on a non-BTC/WETH market)
    const posA0 = await reads.netPositionX18(A, PID), posB0 = await reads.netPositionX18(B, PID);
    say(`  baselines on ${symbol}: A=${posA0} B=${posB0}`);
    results.baseline = { posA0, posB0, flatStart: posA0 === "0" && posB0 === "0" };

    let terminated: string | null = null;
    const checkTerminating = (cs: readonly ExperimentCampaign[]) => {
      const c = cs[0]; if (!c) return;
      for (const g of c.groups) for (const p of g.pairs) {
        for (const r of p.rounds) for (const o of r.orders) if (o.state === "UNKNOWN" || o.cancelState === "UNKNOWN") terminated ||= `order UNKNOWN (round ${r.number}, ${o.role})`;
        if (p.state === "PAUSED" && p.errorCode && /UNKNOWN|FATAL|REJECT/i.test(p.errorCode)) terminated ||= `pair PAUSED ${p.errorCode}`;
      }
    };

    const driver = new BenchmarkDriver(createLiveBenchmarkDriverDeps({
      store,
      engine: { tick: async (id: string) => { const cs = await coordinator.tick(id); checkTerminating(cs); if (terminated) throw new Error(`RUN_TERMINATED: ${terminated}`); return cs; }, query: (id: string) => coordinator.query(id) },
      campaignId: campaign.id, tickMs: Math.max(1, Math.floor(TURBO_SLOT_MS / 20)), now: Date.now, sleep,
    }));

    let summary: Awaited<ReturnType<BenchmarkDriver["runLevel"]>>["summary"] | undefined;
    try {
      await live.connector.ledger.enable(); // the OrderLedger starts HALTED (code TRADING_STOPPED); enable trading
      await coordinator.create(campaign);
      await coordinator.start(campaign.id);
      const startMs = Date.now();
      say(`  driving N=1 for ${WINDOW_MS}ms (TURBO, max round-rate) on ${symbol}…`);
      const level = await driver.runLevel({ atMs: 0, n: 1, holdMs: WINDOW_MS }, { startMs, endMs: startMs + WINDOW_MS });
      summary = level.summary;
      // the fills/sec timeseries (zero-filled quiet buckets → a post-knee stall is visible)
      const metrics = new RunMetrics();
      const allRounds = (await coordinator.query(campaign.id))[0]?.groups.flatMap((g) => g.pairs.flatMap((p) => p.rounds)) ?? [];
      for (const r of allRounds) if (r.orders.length > 0) metrics.addRound(r);
      const series = metrics.fillsPerSecSeries(5000, { startMs, endMs: startMs + WINDOW_MS });
      // Did the deeper maker RE-REST reliably now? maker-rest-rate = A_OPEN posts that did NOT get a
      // post-only-would-cross refusal (2008) ÷ all A_OPEN posts. And did B cross A (self-cross) vs
      // external MM liquidity? self-cross = a round where A's maker and B's taker both filled (the
      // A↔B match); external = B filled but A's maker filled 0 (B swept outside liquidity).
      const aOpens = allRounds.flatMap((r) => r.orders.filter((o) => o.role === "A_OPEN" && o.state !== "ABORTED_UNSENT"));
      const aOpenRefused2008 = aOpens.filter((o) => o.errorCode === "ORDER_REFUSED_2008").length;
      const makerRestRate = aOpens.length ? 1 - aOpenRefused2008 / aOpens.length : 0;
      const bFilledRounds = allRounds.filter((r) => r.orders.some((o) => o.role === "B_OPEN" && BigInt(o.filledX18) > 0n));
      const selfCrossRounds = bFilledRounds.filter((r) => r.orders.some((o) => o.role === "A_OPEN" && BigInt(o.filledX18) > 0n));
      const selfCrossRate = bFilledRounds.length ? selfCrossRounds.length / bFilledRounds.length : 0;
      const setAside = allRounds.filter((r) => r.earlyExitReason === "REPRICE_EXHAUSTED_EXIT").length;
      results.quality = { aOpenPosts: aOpens.length, aOpenRefused2008, makerRestRate, roundsTotal: allRounds.length,
        bFilledRounds: bFilledRounds.length, selfCrossRounds: selfCrossRounds.length, selfCrossRate, repriceSetAside: setAside };
      say(`  QUALITY: maker-rest ${(makerRestRate * 100).toFixed(1)}% (${aOpens.length - aOpenRefused2008}/${aOpens.length} posts rested; ${aOpenRefused2008} refused 2008) · self-cross ${(selfCrossRate * 100).toFixed(1)}% (${selfCrossRounds.length}/${bFilledRounds.length} B-fills crossed A) · reprice-set-aside ${setAside} · rounds ${allRounds.length}`);
      results.run = {
        matchedFills: summary.matchedFills, filledLegs: summary.filledLegs, rounds: summary.rounds, hedgedRounds: summary.hedgedRounds,
        fillsPerSec: summary.fillsPerSec, windowed: summary.windowed, windowMs: summary.windowMs, spanMs: summary.spanMs,
        matchedBaseX18: summary.matchedBaseX18, matchedQuoteX18: summary.matchedQuoteX18,
        latency: summary.latency, series,
      };
      say(`  RUN: matchedFills=${summary.matchedFills} rounds=${summary.rounds} fills/sec=${summary.fillsPerSec.toFixed(3)} p50=${summary.latency.p50}ms p99=${summary.latency.p99}ms span=${summary.spanMs}ms`);
      say(`  fills/sec series (5s buckets): ${series.map((b) => b.matches).join(",")}`);
    } catch (e) {
      results.terminated = terminated ?? (e as Error).message;
      say(`  🚨 RUN TERMINATED: ${results.terminated} — zeros past this are NOT counted.`);
    } finally {
      // DIAGNOSTIC dump: why did/didn't rounds open?
      try {
        const camp = (await coordinator.query(campaign.id))[0];
        const pr = camp?.groups?.[0]?.pairs?.[0];
        say(`  [dump] campaign.state=${camp?.state} wallets=[${Object.keys(camp?.wallets ?? {}).join(",")}] pair.state=${pr?.state} pair.err=${pr?.errorCode ?? "-"} rounds=${pr?.rounds?.length ?? 0} roundStates=[${(pr?.rounds ?? []).map((r) => r.state).join(",")}]`);
        say(`  [dump] firstConnErr=${firstConnErr || "none"}`);
        results.diag = { campaignState: camp?.state, walletKeys: Object.keys(camp?.wallets ?? {}), pairState: pr?.state, pairErr: pr?.errorCode, rounds: pr?.rounds?.length ?? 0, firstConnErr };
      } catch (e) { say(`  [dump] failed: ${(e as Error).message}`); }
      // wind down: request exit so the coordinator closes any open round, then prove flat+settled
      try { await coordinator.requestExit(campaign.id); } catch { /* ignore */ }
      for (let i = 0; i < 40; i++) { await coordinator.tick(campaign.id).catch(() => {}); await sleep(Math.max(1, Math.floor(TURBO_SLOT_MS / 20))); }
      let settled = false; let residue: unknown = null;
      for (let i = 0; i < 10 && !settled; i++) { try { await assertCohortFlatSettled([A, B], { forOwner: (o) => gateway.forOwner(o) as NadoGateway }, { subaccount: SUBACCT }); settled = true; } catch (e) { residue = (e as { residue?: unknown }).residue ?? String(e); await sleep(1000); } }
      const posA = await reads.netPositionX18(A, PID).catch(() => "?"), posB = await reads.netPositionX18(B, PID).catch(() => "?");
      results.settle = { flatSettled: settled, residue, posA, posB, backToBaseline: posA === posA0 && posB === posB0 };
      say(`  SETTLE: flat+settled=${settled} posA=${posA}(base ${posA0}) posB=${posB}(base ${posB0})`);
      disposeFills(); try { ws.close(); } catch { /* ignore */ } transport.closeAll();
      const out = join(process.env.CLAUDE_SCRATCH ?? "/tmp", `sustained-result-${Date.now()}.json`);
      await writeFile(out, JSON.stringify({ results, log }, null, 2)).catch(() => {});
      say(`\n=== results written: ${out} ===`);
    }

    // run-integrity gates
    expect(terminated, `run-terminating event: ${terminated}`).toBeNull();
    expect(summary, "a measured summary was produced").toBeTruthy();
    expect(summary!.matchedFills, "the single pair produced matched fills").toBeGreaterThan(0);
    expect((results.settle as { flatSettled: boolean }).flatSettled, "pair ends flat+settled").toBe(true);
  }, WINDOW_MS + 180_000);
});
