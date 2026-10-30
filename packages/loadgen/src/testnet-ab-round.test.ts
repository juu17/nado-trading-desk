// =============================================================================
// LEG 2 — the LIVE Phase-A testnet validation round (N=1). GATED on NADO_LIVE: the whole
// suite SKIPS this unless NADO_LIVE=1, so `pnpm test` never touches the network/funds. Run it
// explicitly, only after both cohort wallets are funded and on an explicit go:
//
//   NADO_LIVE=1 pnpm exec vitest run packages/loadgen/src/testnet-ab-round.test.ts
//
// It drives ONE A/B self-cross open+close on an empty-book testnet perp using the REAL LEG-1
// wiring (multi-wallet gateway, the A-5 OrderFillSource, sizing, the dispatch normaliser +
// classify, the cohort flat+settled gate), confirms each leg BOTH via OrderFillSource AND an
// independent fresh-position read, and walks all 6 sections of docs/phasea-testnet-validation.md,
// writing a results JSON to the scratchpad. Testnet only; keys stay in custody; abort-safe
// (any resting order is cancelled in finally; a double-place / UNKNOWN / fatal is run-terminating).
// =============================================================================
import { describe, it, expect } from "vitest";
import { EngineClient } from "@nadohq/engine-client";
import {
  CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS, ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS,
  NADO_DEPLOYMENTS, subaccountToHex, getOrderNonce,
} from "@nadohq/client";
import { hashTypedData } from "viem";
import { writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Custody, SharedReadBudget, MeteredTransport, ClockSync } from "@farm/core";
import {
  createMultiWalletNadoGateway, createNadoFillReads, FillAccumulator, subscribeFills,
  nadoMarketSizing, buildPlaceOrderTypedData, buildCancelTypedData, clampOrderSize,
  ENGINE_ORDER_NOT_FOUND_CODE, type NadoGateway,
} from "@farm/adapter-nado";
import type { MarketId } from "@farm/adapter-api";
import { createLiveOrderFillSource } from "./live-order-fill.js";
import { assembleLiveConnector, registerNadoWriteBuckets, canonicalOwner } from "./live-connector.js";
import { defaultNormaliseError } from "./experiment-connector.js";
import { classifyDispatch } from "./classify.js";
import { assertCohortFlatSettled } from "./cohort-settle.js";

const LIVE = process.env.NADO_LIVE === "1" || process.env.NADO_LIVE === "true";
const CHAIN_ID = 763373;
const ENV = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID]!;
const engineUrl = ENGINE_CLIENT_ENDPOINTS[ENV];
const wsUrl = ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS[ENV];
const DEPLOY = NADO_DEPLOYMENTS[ENV];
const SUBACCT = "default";
// Candidate TRADING-ENABLED wide-spread perps (from market-scan — the empty-book markets turned
// out to be trading-BLOCKED, code 2069). We need >=2 ticks of spread to post A strictly at
// top-of-book (ask-tick) so B's IOC crosses ONLY A. First with spread >= 2 ticks wins.
const CANDIDATES = (process.env.AB_PRODUCT_ID ? [Number(process.env.AB_PRODUCT_ID)] : [2, 117, 159, 166, 174, 22, 48, 115, 143, 145, 147, 149, 151, 153, 1, 3]);

const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const fx = (v: unknown): number => (v == null ? NaN : typeof v === "object" && (v as { toFixed?: unknown }).toFixed ? Number((v as { toFixed: () => string }).toFixed()) : Number(v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log: string[] = [];
const say = (s: string) => { console.log(s); log.push(s); };

describe.skipIf(!LIVE)("LEG 2 — live A/B self-cross testnet validation (N=1)", () => {
  it("runs one deterministic self-cross open+close and walks all 6 doc sections", async () => {
    await import("wative-core/node"); // register the Node filesystem backend (live path only)
    const results: Record<string, unknown> = { chainId: CHAIN_ID, env: ENV, startedAt: new Date().toISOString() };
    const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-testnet", "credentials.json"), "utf8"));
    const A = canonicalOwner((cred.wallets?.find((w: { role: string }) => w.role === "A") ?? { address: cred.address }).address);
    const B = canonicalOwner((cred.wallets?.find((w: { role: string }) => w.role === "B") ?? {}).address);
    say(`cohort A=${A} B=${B}`);

    // ---- custody signers (keys stay in the encrypted workspace; never printed) --------------
    const custody = await Custody.open({ path: cred.workspacePath, password: cred.password });
    const cohort = await custody.firstCohort(cred.password);
    const signerA = custody.signerFor(cohort, 0, CHAIN_ID);
    const signerB = custody.signerFor(cohort, 1, CHAIN_ID);
    expect(canonicalOwner(signerA.address.value)).toBe(A);
    expect(canonicalOwner(signerB.address.value)).toBe(B);

    // ---- the live stack: one keyless engine, one 28 read budget + registered write buckets,
    //      one transport, one multi-wallet gateway, the A-5 fill source fed by the keyless WS ---
    const engine = new EngineClient({ url: engineUrl });
    const budget = new SharedReadBudget();
    registerNadoWriteBuckets(budget.rateLimiter);
    const transport = new MeteredTransport({ limiter: budget.rateLimiter, headers: { "accept-encoding": "gzip, deflate" } });
    const readShim = { acquire: async (_bucket: string, weight = 1) => budget.acquire({ weight }) };

    const allMarkets: any[] = await engine.getAllMarkets();
    const symbols: Record<string, any> = (await engine.getSymbols({})).symbols ?? {};
    const symByPid = new Map<number, any>(Object.values(symbols).map((s: any) => [s.productId, s]));

    // Need a >=2-tick spread so A can post strictly at top-of-book (ask-tick) and B's IOC crosses
    // ONLY A. Live MM books are mostly 1-tick but widen intermittently, so poll the candidates for
    // a >=2-tick window and take the WIDEST available (empty books are trading-blocked, code 2069).
    let PID = 0; let mark = NaN; let symbol = ""; let tick = 0; let bestBid = NaN; let bestAsk = NaN;
    const WAIT_ATTEMPTS = Number(process.env.AB_SPREAD_ATTEMPTS ?? 45);
    for (let attempt = 0; attempt < WAIT_ATTEMPTS && !PID; attempt++) {
      let best = { spreadT: 1, pid: 0, tick: 0, symbol: "", bb: NaN, ba: NaN, mark: NaN };
      for (const pid of CANDIDATES) {
        const mkt = allMarkets.find((m: any) => Number(m.productId) === pid);
        const sy = symByPid.get(pid);
        if (!mkt || !sy) continue;
        const t = fx(sy.priceIncrement);
        const liq: any = await engine.getMarketLiquidity({ productId: pid, depth: 1 }).catch(() => ({ bids: [], asks: [] }));
        const bb = fx(liq.bids?.[0]?.price), ba = fx(liq.asks?.[0]?.price);
        const spreadT = (bb > 0 && ba > 0 && t > 0) ? Math.round((ba - bb) / t) : 0;
        if (spreadT > best.spreadT && ba > 0) best = { spreadT, pid, tick: t, symbol: sy.symbol, bb, ba, mark: fx(mkt.product?.oraclePrice) };
      }
      if (best.spreadT >= 2) { PID = best.pid; tick = best.tick; symbol = best.symbol; bestBid = best.bb; bestAsk = best.ba; mark = best.mark; say(`  selected pid=${PID} ${symbol} spread=${best.spreadT}t bid=${bestBid} ask=${bestAsk} (attempt ${attempt + 1})`); break; }
      if (attempt === 0) say(`  widest spread ${best.spreadT}t (<2) — polling ${CANDIDATES.length} candidates for a >=2-tick window…`);
      await sleep(1800);
    }
    if (!PID) throw new Error("no >=2-tick spread appeared on any candidate within the wait window");
    const marketId = `nado:perp:${symbol}` as MarketId;
    const productIds = { [marketId]: PID } as Record<MarketId, number>;
    const sym = symByPid.get(PID)!;
    const sizing = nadoMarketSizing(String(fx(sym.priceIncrement)), BigInt(sym.sizeIncrement.toFixed(0)), BigInt(sym.minSize.toFixed(0)));
    say(`chosen market pid=${PID} ${symbol} bid=${bestBid} ask=${bestAsk} tick=${tick} mark=${mark} sizing=${J(sizing)}`);
    results.market = { productId: PID, symbol, bestBid, bestAsk, tick, mark, sizing };

    const gateway = createMultiWalletNadoGateway({ engine: engine as never, transport, limiter: readShim, engineUrl, chainId: CHAIN_ID, endpoint: DEPLOY.endpoint, markets: [], productIds });

    // keyless public `fill` stream → accumulator (the A-5 wake + per-fill feed)
    const acc = new FillAccumulator();
    const senderA = subaccountToHex({ subaccountOwner: A, subaccountName: SUBACCT });
    const senderB = subaccountToHex({ subaccountOwner: B, subaccountName: SUBACCT });
    const rawFrames: unknown[] = [];
    const WSImpl: any = (globalThis as any).WebSocket;
    const ws: any = new WSImpl(wsUrl);
    const wsReady = new Promise<void>((res) => { ws.onopen = () => res(); });
    ws.onmessage = (ev: any) => { try { const m = JSON.parse(String(ev.data)); if (m?.type === "fill") rawFrames.push(m); } catch { /* ignore */ } };
    await Promise.race([wsReady, sleep(8000)]);
    const socket = { send: (d: string) => ws.send(d), addEventListener: (t: string, l: (ev: { data?: unknown }) => void) => ws.addEventListener(t, l), readyState: ws.readyState as number };
    const disposeFills = subscribeFills(socket, [senderA, senderB], acc, { onWake: (d) => say(`  [wake] fill frame for ${d.slice(0, 10)}…`) });

    const reads = createNadoFillReads({
      engine: engine as never, accumulator: acc, acquire: (u) => budget.acquire({ urgent: u }),
      isOrderNotFound: (err) => { const m = (err as { message?: string })?.message ?? ""; return /^\s*(\d{3,4})\s*:/.test(m) ? Number(/^\s*(\d{3,4})/.exec(m)![1]) === ENGINE_ORDER_NOT_FOUND_CODE : /could not be found|not found/i.test(m); },
    });
    const orderFill = createLiveOrderFillSource(reads);

    // smoke the composition root (proves it assembles live)
    const live = assembleLiveConnector({
      chainId: CHAIN_ID, endpoint: DEPLOY.endpoint, gateway, signers: [signerA, signerB],
      sizingFor: () => sizing, marketIdFor: () => marketId, clock: () => new ClockSync().now(), orderFill,
      admit: () => {}, store: { /* unused on this direct path */ } as never,
    });
    expect(live.owners.sort()).toEqual([A, B].sort());

    const signerFor = (o: string) => (canonicalOwner(o) === A ? signerA : signerB);
    const restingDigests: Array<{ owner: string; digest: string }> = [];

    // ---- helpers ----------------------------------------------------------------------------
    const alignTick = (p: number): number => { const t = Number(sizing.tickSize) || 1; return Math.round(p / t) * t; };
    const sizeHuman = clampOrderSize(sizing.minSize, { stepSize: sizing.stepSize, minSize: sizing.minSize, price: String(bestAsk), minNotional: sizing.minNotional });

    async function place(owner: string, o: { side: "buy" | "sell"; priceHuman: string; sizeHuman: string; postOnly: boolean; reduceOnly: boolean; clientId: string }) {
      const nonce = getOrderNonce();
      const expiration = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const built = buildPlaceOrderTypedData(
        { market: marketId, side: o.side, kind: o.postOnly ? "limit" : "market", size: o.sizeHuman as never, price: o.priceHuman as never, tif: o.postOnly ? "gtc" : "ioc", postOnly: o.postOnly, reduceOnly: o.reduceOnly, clientId: o.clientId },
        { chainId: CHAIN_ID, productId: PID, ownerAddress: owner, subaccountName: SUBACCT, nonce: BigInt(nonce), expiration },
      );
      const signature = await signerFor(owner).signTypedData!(built.typedData as never, CHAIN_ID);
      const digest = hashTypedData(built.typedData as never);
      say(`  place ${o.side} ${o.postOnly ? "maker" : "IOC"}${o.reduceOnly ? " reduce" : ""} owner=${owner.slice(0, 8)} px=${o.priceHuman} sz=${o.sizeHuman} digest=${digest.slice(0, 10)}…`);
      try {
        const res = await gateway.forOwner(owner).submitOrder({ productId: PID, order: built.order, sender: built.sender, signature } as never);
        say(`    submit OK → ${J(res).slice(0, 160)}`);
        return { ok: true as const, digest, res };
      } catch (error) {
        const info = defaultNormaliseError(error); const verdict = classifyDispatch(info);
        say(`    submit FAIL → normalise=${J(info)} verdict=${J(verdict)}`);
        return { ok: false as const, digest, error, info, verdict };
      }
    }
    async function pollFill(owner: string, digest: string, until: (f: Awaited<ReturnType<typeof orderFill>>) => boolean, label: string, timeoutMs = 25_000) {
      const t0 = Date.now();
      for (;;) {
        const f = await orderFill(owner, PID, digest);
        if (until(f)) return { f, waitedMs: Date.now() - t0 };
        if (Date.now() - t0 > timeoutMs) { say(`    [timeout] ${label} last=${J(f)}`); return { f, waitedMs: Date.now() - t0, timedOut: true }; }
        await sleep(600);
      }
    }
    const netPos = (owner: string) => reads.netPositionX18(owner, PID);
    async function pollPos(owner: string, until: (p: string) => boolean, label: string, timeoutMs = 20_000) {
      const t0 = Date.now();
      // The engine position in getSubaccountSummary LAGS the fill stream — poll until it reflects it.
      for (;;) {
        const p = await netPos(owner);
        if (until(p)) return { p, waitedMs: Date.now() - t0 };
        if (Date.now() - t0 > timeoutMs) { say(`    [pos timeout] ${label} last=${p}`); return { p, waitedMs: Date.now() - t0, timedOut: true }; }
        await sleep(700);
      }
    }
    async function cancel(owner: string, digest: string) {
      const built = buildCancelTypedData({ venueIds: [digest] }, { chainId: CHAIN_ID, ownerAddress: owner, subaccountName: SUBACCT, verifyingContract: DEPLOY.endpoint }, [PID]);
      const signature = await signerFor(owner).signTypedData!(built.typedData as never, CHAIN_ID);
      await gateway.forOwner(owner).cancelOrders({ ...built, signature } as never).catch((e) => say(`    cancel err ${(e as Error).message}`));
    }

    try {
      // baselines: the wallets may carry pre-existing inventory (earlier testing), so we measure
      // the round by DELTAS from here and run the ABSOLUTE flat gate only when genuinely flat-start.
      const posA0 = await netPos(A); const posB0 = await netPos(B);
      const flatStart = posA0 === "0" && posB0 === "0";
      say(`  baselines: A=${posA0} B=${posB0} flatStart=${flatStart}`);
      results.baseline = { posA0, posB0, flatStart };

      // =========================== OPEN: A resting maker, B taker self-cross ==================
      // A BUY post-only at (current best bid + 1 tick) → strictly the highest bid (above every
      // existing bid) and safely below the ask, so B's IOC SELL at that price crosses ONLY A. The
      // MM book races, so re-read it right before placing and retry a transient post-only-cross (2008).
      let openPrice = ""; let aOpen: Awaited<ReturnType<typeof place>> | undefined;
      for (let tryA = 0; tryA < 5; tryA++) {
        const bk: any = await engine.getMarketLiquidity({ productId: PID, depth: 1 }).catch(() => ({ bids: [], asks: [] }));
        const bb = fx(bk.bids?.[0]?.price), ba = fx(bk.asks?.[0]?.price);
        const sp = (bb > 0 && ba > 0) ? Math.round((ba - bb) / tick) : 0;
        if (sp < 2) { say(`  spread collapsed to ${sp}t — waiting for room…`); await sleep(1500); continue; }
        openPrice = String(alignTick(bb + tick));
        aOpen = await place(A, { side: "buy", priceHuman: openPrice, sizeHuman, postOnly: true, reduceOnly: false, clientId: `ab:A_OPEN:${tryA}` });
        if (aOpen.ok) break;
        say(`  A maker refused (${J((aOpen as { verdict?: unknown }).verdict)}) — re-reading book + re-pricing`);
        await sleep(900);
      }
      expect(aOpen?.ok, `A maker submit: ${J((aOpen as { verdict?: unknown } | undefined)?.verdict)}`).toBe(true);
      if (aOpen!.ok) restingDigests.push({ owner: A, digest: aOpen!.digest });
      const aResting = await pollFill(A, aOpen!.digest, (f) => !!f && f.resting === true, "A maker resting");
      say(`  A maker resting? ${J(aResting.f)} (waited ${aResting.waitedMs}ms)`);
      expect(aResting.f?.resting, "A post-only maker must REST at top-of-book").toBe(true);
      // determinism evidence: A should now be the unique best bid
      const bookAfterA: any = await engine.getMarketLiquidity({ productId: PID, depth: 1 }).catch(() => ({ bids: [] }));
      const topBidAfterA = fx(bookAfterA.bids?.[0]?.price);
      results.makerIsTopBid = topBidAfterA === Number(openPrice);
      say(`  top bid after A = ${topBidAfterA} (A at ${openPrice}); A is top? ${results.makerIsTopBid}`);

      // B IOC SELL at A's price → crosses only A (A is the unique highest bid); fills at A's price
      const tCross0 = Date.now();
      const bOpen = await place(B, { side: "sell", priceHuman: openPrice, sizeHuman, postOnly: false, reduceOnly: false, clientId: "ab:B_OPEN" });
      expect(bOpen.ok, `B taker submit: ${J((bOpen as { verdict?: unknown }).verdict)}`).toBe(true);

      // confirm BOTH legs filled via OrderFillSource
      const aFilled = await pollFill(A, aOpen!.digest, (f) => !!f && f.terminal === true, "A maker→terminal");
      const bFilled = await pollFill(B, bOpen.digest, (f) => !!f && f.terminal === true, "B taker→terminal");
      const latencyMs = Date.now() - tCross0;
      if (aFilled.f?.terminal) restingDigests.length = 0; // A consumed
      expect(aFilled.f?.terminal, "A maker must settle terminal (filled)").toBe(true);
      expect(bFilled.f?.terminal, "B taker IOC must settle terminal").toBe(true);
      // pure A<->B self-cross evidence: equal base, equal quote, A is the maker (fee <= taker)
      const aBase = BigInt(aFilled.f!.filledX18), bBase = BigInt(bFilled.f!.filledX18);
      say(`  self-cross: A base=${aBase} quote=${aFilled.f!.quoteFilledX18} fee=${aFilled.f!.feePaidX18} | B base=${bBase} quote=${bFilled.f!.quoteFilledX18} fee=${bFilled.f!.feePaidX18} | latency ${latencyMs}ms`);
      expect(aBase.toString(), "A and B fill the SAME base qty (pure self-cross)").toBe(bBase.toString());
      expect(aFilled.f!.quoteFilledX18, "A and B fill at the SAME quote").toBe(bFilled.f!.quoteFilledX18);
      expect(BigInt(aFilled.f!.feePaidX18) <= BigInt(bFilled.f!.feePaidX18), "A pays the MAKER fee (<= B's taker fee)").toBe(true);
      // position reconciliation (A-5): poll until the engine position reflects the cross (fills lead position)
      const aPos = await pollPos(A, (p) => BigInt(p) - BigInt(posA0) === aBase, "A +fill");
      const bPos = await pollPos(B, (p) => BigInt(posB0) - BigInt(p) === bBase, "B -fill");
      say(`  OPEN positions: A ${posA0}->${aPos.p} B ${posB0}->${bPos.p}`);
      expect((BigInt(aPos.p) - BigInt(posA0)).toString(), "A position moved +fill (reconciliation)").toBe(aBase.toString());
      expect((BigInt(posB0) - BigInt(bPos.p)).toString(), "B position moved -fill (reconciliation)").toBe(bBase.toString());
      const posA = aPos.p, posB = bPos.p;
      results.open = { aFill: aFilled.f, bFill: bFilled.f, posA0, posB0, posA, posB, latencyMs, makerResting: aResting.f };

      // =========================== CLOSE: B reduce maker, A reduce IOC =======================
      // mirror of the open: B BUY reduce-only post-only at ask-tick (top bid) → A SELL reduce-only
      // IOC at that price crosses ONLY B. Re-read the book (the MM quotes may have moved).
      const liq2: any = await engine.getMarketLiquidity({ productId: PID, depth: 1 }).catch(() => ({ asks: [{ price: bestAsk }] }));
      const ask2 = fx(liq2.asks?.[0]?.price) || bestAsk;
      const closePrice = String(alignTick(ask2 - tick));
      const absPos = aBase.toString(); // unwind ONLY the round's own base (reduce-only; wallets may hold prior inventory)
      const closeSizeHuman = formatBaseX18(absPos);
      // reduce-only is relative to the wallet's NET position; with pre-existing inventory a
      // reduce-only BUY on a net-long wallet is 2067-refused. Use reduce-only only when flat-start
      // (the designed mirror); otherwise plain exact-size orders still net the round back to baseline.
      const bClose = await place(B, { side: "buy", priceHuman: closePrice, sizeHuman: closeSizeHuman, postOnly: true, reduceOnly: flatStart, clientId: "ab:B_CLOSE" });
      expect(bClose.ok, `B close maker: ${J((bClose as { verdict?: unknown }).verdict)}`).toBe(true);
      if (bClose.ok) restingDigests.push({ owner: B, digest: bClose.digest });
      const bcResting = await pollFill(B, bClose.digest, (f) => !!f && f.resting === true, "B close maker resting");
      say(`  B close maker resting? ${J(bcResting.f)}`);

      const tClose0 = Date.now();
      const aClose = await place(A, { side: "sell", priceHuman: closePrice, sizeHuman: closeSizeHuman, postOnly: false, reduceOnly: flatStart, clientId: "ab:A_CLOSE" });
      expect(aClose.ok, `A close IOC: ${J((aClose as { verdict?: unknown }).verdict)}`).toBe(true);
      const bcFilled = await pollFill(B, bClose.digest, (f) => !!f && f.terminal === true, "B close→terminal");
      const acFilled = await pollFill(A, aClose.digest, (f) => !!f && f.terminal === true, "A close→terminal");
      const closeLatencyMs = Date.now() - tClose0;
      if (bcFilled.f?.terminal) restingDigests.length = 0;
      expect(acFilled.f?.terminal, "A close IOC must settle terminal").toBe(true);
      expect(bcFilled.f?.terminal, "B close maker must settle terminal").toBe(true);
      // positions return to baseline — the round net-zeroed its own delta
      const aPos2 = await pollPos(A, (p) => p === posA0, "A back to baseline");
      const bPos2 = await pollPos(B, (p) => p === posB0, "B back to baseline");
      say(`  CLOSE positions: A ${aPos2.p}(base ${posA0}) B ${bPos2.p}(base ${posB0}) | close latency ${closeLatencyMs}ms`);
      expect(aPos2.p, "A returned to baseline").toBe(posA0);
      expect(bPos2.p, "B returned to baseline").toBe(posB0);
      results.close = { aFill: acFilled.f, bFill: bcFilled.f, posA: aPos2.p, posB: bPos2.p, latencyMs: closeLatencyMs, reduceOnly: flatStart };

      // =========================== §6 settle: the round left no residue =======================
      let noOpenOrders = true;
      for (const o of [A, B]) { if ((await gateway.forOwner(o).getOpenOrders(SUBACCT)).length) noOpenOrders = false; }
      const returnedToBaseline = aPos2.p === posA0 && bPos2.p === posB0;
      let absoluteFlatGate = flatStart ? "FAIL" : "n/a (wallets carry pre-existing inventory; round measured by delta-to-baseline)";
      if (flatStart) { for (let i = 0; i < 8; i++) { try { await assertCohortFlatSettled([A, B], { forOwner: (o) => gateway.forOwner(o) as NadoGateway }, { subaccount: SUBACCT }); absoluteFlatGate = "PASS"; break; } catch { await sleep(800); } } }
      say(`  §6 settle: noOpenOrders=${noOpenOrders} returnedToBaseline=${returnedToBaseline} absoluteFlatGate=${absoluteFlatGate}`);
      results.settle = { noOpenOrders, returnedToBaseline, absoluteFlatGate };
      expect(noOpenOrders, "no resting orders after the round").toBe(true);
      expect(returnedToBaseline, "round net-zeroed (positions back to baseline)").toBe(true);

      // =========================== §1 classify — a DELIBERATE refusal ========================
      // Post-only that WOULD cross (A buys above its own resting? book is empty now) — instead
      // trigger a below-min-size refusal: a size of one step but price so low notional < min.
      // Simplest deterministic refusal: a post-only SELL far below mark on an empty book cannot
      // cross (rests) — so use an explicit too-small order via a 1-wei size is not expressible;
      // instead probe a known refusal by placing a reduce-only order with no position (A is flat).
      const refusePrice = String(alignTick(bestAsk * 1.05)); // BUY post-only ABOVE the ask → must cross → post-only refuses
      const refusal = await place(A, { side: "buy", priceHuman: refusePrice, sizeHuman, postOnly: true, reduceOnly: false, clientId: "ab:REFUSE_PROBE" });
      if (refusal.ok) restingDigests.push({ owner: A, digest: refusal.digest }); // unexpectedly rested → cancel in finally
      results.classifyProbe = refusal.ok
        ? { note: "post-only above ask unexpectedly rested (did not cross) — cancelled", digest: refusal.digest }
        : { trigger: "post-only would cross (BUY above ask)", normalise: refusal.info, verdict: refusal.verdict };
      say(`  §1 refusal probe (post-only would cross): ${refusal.ok ? "rested (will cancel)" : `classified ${J(refusal.verdict)} nadoCode=${(refusal.info as { nadoCode?: number })?.nadoCode}`}`);

      // ---- record the raw fill-frame shape captured live (§2 confirmation) ----
      results.rawFillFrames = rawFrames.slice(0, 6);
      say(`  §2 captured ${rawFrames.length} raw fill frames; sample=${J(rawFrames[0] ?? null).slice(0, 300)}`);
      results.sizingSanity = { sizeHuman, notionalApprox: Number(sizeHuman) * mark, clearsMinNotional: Number(sizeHuman) * mark >= Number(sizing.minNotional) };
      results.finishedAt = new Date().toISOString();
    } finally {
      for (const r of restingDigests) { say(`  [cleanup] cancel ${r.owner.slice(0, 8)} ${r.digest.slice(0, 10)}…`); await cancel(r.owner, r.digest); }
      disposeFills(); try { ws.close(); } catch { /* ignore */ } transport.closeAll();
      const out = join(process.env.CLAUDE_SCRATCH ?? "/tmp", `ab-round-result-${Date.now()}.json`);
      await writeFile(out, JSON.stringify({ results, log }, null, 2)).catch(() => {});
      say(`\n=== results written: ${out} ===`);
    }
  }, 240_000);
});

// X18 integer string → human decimal string (18 dp, trimmed).
function formatBaseX18(x18: string): string {
  const neg = x18.startsWith("-"); const s = (neg ? x18.slice(1) : x18).padStart(19, "0");
  const i = s.slice(0, -18), f = s.slice(-18).replace(/0+$/, "");
  return (neg ? "-" : "") + (f ? `${i}.${f}` : i);
}
