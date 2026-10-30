// =============================================================================
// LEG 3 prep — FLATTEN the cohort (reduce-only) so the N=1 coordinator baseline can run on BTC.
// GATED on NADO_LIVE; skipped offline. Brings both wallets to ZERO on BTC (pid 2) and WETH (pid
// 3) using ONLY reduce-only orders (can never open new exposure), via the proven
// buildPlaceOrderTypedData + gateway path (LEG-2 validated). Three phases:
//   1. A<->B overlap cross (no book impact): A and B hold OPPOSITE BTC inventory (A short, B
//      long), so A reduce-only BUY maker <-> B reduce-only SELL IOC nets the overlap (A's full
//      short) — flattens A, reduces B — in chunks, each a deterministic top-of-book self-cross.
//   2. B's BTC remainder -> the book: small reduce-only SELL IOC chunks at the top bid, with
//      refill pauses (limit + IOC keep each fill near top, so we never walk to the band floor).
//   3. B's WETH -> the book: one/few reduce-only SELL IOC.
// Monitored by position deltas; a stuck residual / reduce-only rejection / persistent zero-fill
// HALTS and flags (never improvises large market orders). Testnet only; keys stay in custody.
//
//   NADO_LIVE=1 pnpm exec vitest run packages/loadgen/src/testnet-flatten.test.ts
// =============================================================================
import { describe, it, expect } from "vitest";
import { EngineClient } from "@nadohq/engine-client";
import { CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS, NADO_DEPLOYMENTS, getOrderNonce } from "@nadohq/client";
import { hashTypedData } from "viem";
import { writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Custody, SharedReadBudget, MeteredTransport } from "@farm/core";
import {
  createMultiWalletNadoGateway, nadoMarketSizing, buildPlaceOrderTypedData, buildCancelTypedData, clampOrderSize,
} from "@farm/adapter-nado";
import type { MarketId } from "@farm/adapter-api";
import { registerNadoWriteBuckets, canonicalOwner } from "./live-connector.js";
import { classifyDispatch } from "./classify.js";
import { defaultNormaliseError } from "./experiment-connector.js";

const LIVE = process.env.NADO_LIVE === "1" || process.env.NADO_LIVE === "true";
const CHAIN_ID = 763373;
const ENV = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID]!;
const engineUrl = ENGINE_CLIENT_ENDPOINTS[ENV];
const DEPLOY = NADO_DEPLOYMENTS[ENV];
const SUBACCT = "default";
const BTC = 2, WETH = 3;
const CHUNK_BTC = Number(process.env.FLATTEN_CHUNK_BTC ?? 1.0); // per-order size cap
const EPS = 1e-6;
const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const fx = (v: unknown): number => (v == null ? NaN : typeof v === "object" && (v as { toFixed?: unknown }).toFixed ? Number((v as { toFixed: () => string }).toFixed()) : Number(v));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log: string[] = [];
const say = (s: string) => { console.log(s); log.push(s); };

describe.skipIf(!LIVE)("LEG 3 prep — flatten the cohort to zero (reduce-only)", () => {
  it("flattens A and B to zero on BTC and WETH, overlap-crossing A<->B then marketing the remainder", async () => {
    await import("wative-core/node");
    const results: Record<string, unknown> = { chainId: CHAIN_ID, startedAt: new Date().toISOString() };
    const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-testnet", "credentials.json"), "utf8"));
    const A = canonicalOwner((cred.wallets?.find((w: { role: string }) => w.role === "A") ?? { address: cred.address }).address);
    const B = canonicalOwner((cred.wallets?.find((w: { role: string }) => w.role === "B") ?? {}).address);
    const custody = await Custody.open({ path: cred.workspacePath, password: cred.password });
    const cohort = await custody.firstCohort(cred.password);
    const signerA = custody.signerFor(cohort, 0, CHAIN_ID);
    const signerB = custody.signerFor(cohort, 1, CHAIN_ID);
    const signerFor = (o: string) => (canonicalOwner(o) === A ? signerA : signerB);

    const engine = new EngineClient({ url: engineUrl });
    const budget = new SharedReadBudget();
    registerNadoWriteBuckets(budget.rateLimiter);
    const transport = new MeteredTransport({ limiter: budget.rateLimiter, headers: { "accept-encoding": "gzip, deflate" } });
    const readShim = { acquire: async (_b: string, w = 1) => budget.acquire({ weight: w }) };
    const markets: any[] = await engine.getAllMarkets();
    const symbols: Record<string, any> = (await engine.getSymbols({})).symbols ?? {};
    const symByPid = new Map<number, any>(Object.values(symbols).map((s: any) => [s.productId, s]));
    const marketIdOf = (pid: number) => `nado:perp:${symByPid.get(pid)?.symbol ?? pid}` as MarketId;
    const productIds = { [marketIdOf(BTC)]: BTC, [marketIdOf(WETH)]: WETH } as Record<MarketId, number>;
    const sizingOf = (pid: number) => { const s = symByPid.get(pid); return nadoMarketSizing(String(fx(s.priceIncrement)), BigInt(s.sizeIncrement.toFixed(0)), BigInt(s.minSize.toFixed(0))); };
    const gateway = createMultiWalletNadoGateway({ engine: engine as never, transport, limiter: readShim, engineUrl, chainId: CHAIN_ID, endpoint: DEPLOY.endpoint, markets: [], productIds });

    const posX18 = async (owner: string, pid: number): Promise<bigint> => {
      await budget.acquire({ urgent: true });
      const sum: any = await engine.getSubaccountSummary({ subaccountOwner: owner, subaccountName: SUBACCT });
      const bal = (sum.balances ?? []).find((b: any) => Number(b.productId) === pid);
      if (!bal || bal.amount == null) return 0n;
      return BigInt(bal.amount.toFixed ? bal.amount.toFixed(0) : String(bal.amount).split(".")[0] || "0");
    };
    const posBTC = (owner: string, pid: number) => posX18(owner, pid).then((x) => Number(x) / 1e18);
    const topBook = async (pid: number) => { const liq: any = await engine.getMarketLiquidity({ productId: pid, depth: 1 }).catch(() => ({ bids: [], asks: [] })); return { bid: fx(liq.bids?.[0]?.price), ask: fx(liq.asks?.[0]?.price) }; };

    async function place(owner: string, o: { pid: number; side: "buy" | "sell"; priceHuman: string; sizeHuman: string; postOnly: boolean; reduceOnly: boolean; tag: string }) {
      const built = buildPlaceOrderTypedData(
        { market: marketIdOf(o.pid), side: o.side, kind: o.postOnly ? "limit" : "market", size: o.sizeHuman as never, price: o.priceHuman as never, tif: o.postOnly ? "gtc" : "ioc", postOnly: o.postOnly, reduceOnly: o.reduceOnly, clientId: o.tag },
        { chainId: CHAIN_ID, productId: o.pid, ownerAddress: owner, subaccountName: SUBACCT, nonce: BigInt(getOrderNonce()), expiration: BigInt(Math.floor(Date.now() / 1000) + 600) },
      );
      const signature = await signerFor(owner).signTypedData!(built.typedData as never, CHAIN_ID);
      const digest = hashTypedData(built.typedData as never);
      try { const res = await gateway.forOwner(owner).submitOrder({ productId: o.pid, order: built.order, sender: built.sender, signature } as never); return { ok: true as const, digest, res }; }
      catch (error) { const info = defaultNormaliseError(error); return { ok: false as const, digest, info, verdict: classifyDispatch(info) }; }
    }
    const alignTick = (pid: number, p: number) => { const t = Number(sizingOf(pid).tickSize) || 1; return Math.round(p / t) * t; };
    const clampSize = (pid: number, base: number, price: number) => clampOrderSize(String(base), { stepSize: sizingOf(pid).stepSize, minSize: sizingOf(pid).minSize, price: String(price), minNotional: sizingOf(pid).minNotional });
    async function cancelAllOpen(owner: string, pid: number) {
      const open = await gateway.forOwner(owner).getOpenOrders(SUBACCT).catch(() => []);
      const digests = open.map((o) => o.venueId ?? "").filter(Boolean);
      if (!digests.length) return;
      const built = buildCancelTypedData({ venueIds: digests }, { chainId: CHAIN_ID, ownerAddress: owner, subaccountName: SUBACCT, verifyingContract: DEPLOY.endpoint }, [pid]);
      const signature = await signerFor(owner).signTypedData!(built.typedData as never, CHAIN_ID);
      await gateway.forOwner(owner).cancelOrders({ ...built, signature } as never).catch((e) => say(`  cancel err ${(e as Error).message}`));
    }

    let halt: string | null = null;
    try {
      const a0 = await posBTC(A, BTC), b0btc = await posBTC(B, BTC), b0weth = await posBTC(B, WETH);
      results.baseline = { aBtc: a0, bBtc: b0btc, bWeth: b0weth };
      say(`baselines: A.btc=${a0} B.btc=${b0btc} B.weth=${b0weth}`);

      // ---------- Phase 1: flatten A's BTC short (reduce-only BUY IOC into the asks) ----------
      // Pure book flatten per wallet (robust — no spread/determinism dependency): A buys to cover
      // its short, B sells to close its long. Each chunk is a reduce-only IOC at the top of book
      // (limit + IOC keep fills near top; the rest is killed), with refill pauses.
      say(`\nPhase 1: flatten A's BTC short (reduce-only BUY IOC)`);
      { let zeroStreak = 0, bought = 0;
        while (Math.abs(await posBTC(A, BTC)) > EPS && !halt) {
          const c = Math.min(CHUNK_BTC, Math.abs(await posBTC(A, BTC)));
          const { ask } = await topBook(BTC);
          if (!(ask > 0)) { halt = "Phase1 no ask"; break; }
          const price = String(alignTick(BTC, ask * 1.001)); // cross the top asks; IOC kills the rest
          const size = clampSize(BTC, c, Number(price));
          const p0 = await posBTC(A, BTC);
          const r = await place(A, { pid: BTC, side: "buy", priceHuman: price, sizeHuman: size, postOnly: false, reduceOnly: true, tag: "flat:A_buy" });
          if (!r.ok) { if (r.verdict.kind === "refused") { await sleep(800); if (++zeroStreak >= 6) halt = `Phase1 repeated refusal ${J(r.verdict)} ${r.info.message}`; continue; } halt = `Phase1 BUY ${J(r.verdict)} ${r.info.message}`; break; }
          await sleep(900);
          const moved = (await posBTC(A, BTC)) - p0; // short → toward 0 (position increases)
          bought += Math.max(0, moved);
          say(`  A buy ${size}@~${price} A.btc:${p0.toFixed(4)}->${(await posBTC(A, BTC)).toFixed(4)} (Δ${moved.toFixed(5)})`);
          if (moved < EPS) { if (++zeroStreak >= 6) { halt = "Phase1 persistent zero-fill (ask-side not refilling)"; break; } await sleep(1500); } else zeroStreak = 0;
          await sleep(1200); // let the MM refill the top of book
        }
        results.phase1 = { boughtBtc: bought, aBtcAfter: await posBTC(A, BTC) };
        say(`  phase1 done: A.btc=${await posBTC(A, BTC)}`);
      }

      // ---------- Phase 2: B's BTC remainder -> the book (reduce-only SELL IOC chunks) ----------
      if (!halt) {
        say(`\nPhase 2: market B's BTC remainder (reduce-only SELL IOC chunks)`);
        let zeroStreak = 0, sold = 0;
        while ((await posBTC(B, BTC)) > EPS && !halt) {
          const remain = await posBTC(B, BTC);
          const c = Math.min(CHUNK_BTC, remain);
          const { bid } = await topBook(BTC);
          if (!(bid > 0)) { halt = "Phase2 no bid"; break; }
          const price = String(alignTick(BTC, bid * 0.999)); // cross the top bids; IOC kills the rest
          const size = clampSize(BTC, c, Number(price));
          const p0 = await posBTC(B, BTC);
          const r = await place(B, { pid: BTC, side: "sell", priceHuman: price, sizeHuman: size, postOnly: false, reduceOnly: true, tag: "flat:B_mkt" });
          if (!r.ok) { if (r.verdict.kind === "refused") { await sleep(800); zeroStreak++; if (zeroStreak >= 6) { halt = `Phase2 repeated refusal ${J(r.verdict)} ${r.info.message}`; } continue; } halt = `Phase2 SELL ${J(r.verdict)} ${r.info.message}`; break; }
          await sleep(900);
          const moved = p0 - (await posBTC(B, BTC));
          sold += Math.max(0, moved);
          say(`  sell chunk ${size}@~${price} B.btc:${p0.toFixed(4)}->${(await posBTC(B, BTC)).toFixed(4)} (Δ${moved.toFixed(5)}) sold=${sold.toFixed(4)}`);
          if (moved < EPS) { zeroStreak++; if (zeroStreak >= 6) { halt = "Phase2 persistent zero-fill (book not refilling / stuck residual)"; break; } await sleep(1500); } else zeroStreak = 0;
          await sleep(1200); // let the MM refill the top of book
        }
        results.phase2 = { soldBtc: sold, bBtcAfter: await posBTC(B, BTC) };
        say(`  phase2 done: B.btc=${await posBTC(B, BTC)} sold=${sold.toFixed(4)}`);
      }

      // ---------- Phase 3: B's WETH -> the book ----------
      if (!halt) {
        say(`\nPhase 3: flatten B's WETH`);
        let zeroStreak = 0;
        while ((await posBTC(B, WETH)) > EPS && !halt) {
          const remain = await posBTC(B, WETH);
          const { bid } = await topBook(WETH);
          if (!(bid > 0)) { halt = "Phase3 no bid"; break; }
          const price = String(alignTick(WETH, bid * 0.999));
          const size = clampSize(WETH, Math.min(remain, 10), Number(price));
          const p0 = await posBTC(B, WETH);
          const r = await place(B, { pid: WETH, side: "sell", priceHuman: price, sizeHuman: size, postOnly: false, reduceOnly: true, tag: "flat:B_weth" });
          if (!r.ok) { halt = `Phase3 SELL ${J(r.verdict)} ${r.info.message}`; break; }
          await sleep(900);
          const moved = p0 - (await posBTC(B, WETH));
          say(`  weth sell ${size}@~${price} Δ${moved.toFixed(6)} B.weth=${(await posBTC(B, WETH)).toFixed(6)}`);
          if (moved < 1e-7) { zeroStreak++; if (zeroStreak >= 5) { halt = "Phase3 persistent zero-fill"; break; } await sleep(1200); } else zeroStreak = 0;
        }
        results.phase3 = { bWethAfter: await posBTC(B, WETH) };
      }

      const aBtc = await posBTC(A, BTC), bBtc = await posBTC(B, BTC), bWeth = await posBTC(B, WETH);
      const flat = Math.abs(aBtc) <= EPS && Math.abs(bBtc) <= EPS && Math.abs(bWeth) <= EPS;
      results.final = { aBtc, bBtc, bWeth, flat, halt };
      say(`\nFINAL: A.btc=${aBtc} B.btc=${bBtc} B.weth=${bWeth} flat=${flat} halt=${halt ?? "none"}`);
    } finally {
      // cancel any resting orders both wallets left behind
      for (const o of [A, B]) for (const pid of [BTC, WETH]) await cancelAllOpen(o, pid).catch(() => {});
      transport.closeAll();
      const out = join(process.env.CLAUDE_SCRATCH ?? "/tmp", `flatten-result-${Date.now()}.json`);
      await writeFile(out, JSON.stringify({ results, log }, null, 2)).catch(() => {});
      say(`\n=== results written: ${out} ===`);
    }

    expect(halt, `flatten halted (flag to parent): ${halt}`).toBeNull();
    expect((results.final as { flat: boolean }).flat, "both wallets flat on BTC + WETH").toBe(true);
  }, 600_000);
});
