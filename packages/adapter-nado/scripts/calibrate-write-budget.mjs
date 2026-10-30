// LEG 3 step 1 — LIVE write-budget calibration. Steps the order place/cancel rate up from
// conservative and STOPS at the FIRST 429 / WAF / rejection (no sustained hammering — a sustained
// burst risks a Cloudflare WAF cooldown; see the accept-encoding note). Records the per-IP
// place/cancel allowance to feed into registerNadoWriteBuckets. SEPARATE from the measured run.
//
// Safety: uses wallet A on a NON-BTC market it is flat in, places DEEP post-only makers (~10%
// below oracle — within the price band, never crossing, so no fill) and cancels each immediately;
// cancels any leftover + reports any accidental position at the end. Hard-gated on NADO_LIVE.
//
//   NADO_LIVE=1 node packages/adapter-nado/scripts/calibrate-write-budget.mjs
import "wative-core/node";
import { Workspace } from "wative-core";
import { createWalletClient, createPublicClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EngineClient } from "@nadohq/engine-client";
import { CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS, NADO_DEPLOYMENTS, getOrderNonce, getOrderVerifyingAddress, packOrderAppendix } from "@nadohq/client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

if (!(process.env.NADO_LIVE === "1" || process.env.NADO_LIVE === "true")) { console.error("NADO_LIVE unset — refusing to hit the live sequencer."); process.exit(2); }
const CHAIN_ID = 763373;
const ENV = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID];
const engineUrl = ENGINE_CLIENT_ENDPOINTS[ENV];
const deploy = NADO_DEPLOYMENTS[ENV];
const rpc = process.env.INK_TESTNET_RPC || "https://rpc-gel-sepolia.inkonchain.com";
const SUBACCT = "default";
const CANDIDATES = [166, 174, 145, 147, 149, 115, 117]; // non-BTC/WETH liquid perps A is flat in
const RATES = [4, 8, 12, 16, 20, 24, 28, 32, 36, 40]; // place+cancel PAIRS per second, stepped
const WINDOW_MS = 2500; // short window per rate step (no sustained hammering)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fx = (v) => (v == null ? NaN : v.toFixed ? Number(v.toFixed()) : Number(v));
const J = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const is429 = (m) => /\b429\b|rate.?limit|too many|1000|1015|compression|403/i.test(String(m || ""));

const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-testnet", "credentials.json"), "utf8"));
const ws = await Workspace.open({ path: cred.workspacePath, password: cred.password });
const acc = ws.accounts[0]; await acc.tryUnlock(cred.password);
let pk = acc.getWalletList()[0].dumpPrivateKey("evm"); if (!pk.startsWith("0x")) pk = "0x" + pk;
await ws.lock();
const chain = defineChain({ id: CHAIN_ID, name: "Ink Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const account = privateKeyToAccount(pk);
const walletClient = createWalletClient({ account, chain, transport: http(rpc) });
const engine = new EngineClient({ url: engineUrl, walletClient });
const addr = account.address;
console.log(`calibrate-write-budget wallet=${addr} env=${ENV}`);

// pick a liquid non-BTC market A is flat in
const markets = await engine.getAllMarkets();
const syms = (await engine.getSymbols({})).symbols ?? {};
let PID = 0, tick = 0, step = 0, oracle = 0, sym = "";
for (const pid of CANDIDATES) {
  const m = markets.find((x) => Number(x.productId) === pid); const s = Object.values(syms).find((x) => x.productId === pid);
  if (!m || !s) continue;
  const liq = await engine.getMarketLiquidity({ productId: pid, depth: 1 }).catch(() => ({ bids: [], asks: [] }));
  if ((liq.bids?.length ?? 0) === 0) continue;
  PID = pid; tick = fx(s.priceIncrement); step = fx(s.sizeIncrement) / 1e18; oracle = fx(m.product?.oraclePrice); sym = s.symbol; break;
}
if (!PID) { console.error("no liquid non-BTC candidate market"); process.exit(3); }
const priceDeep = Math.round((oracle * 0.9) / tick) * tick; // deep BUY, within band, won't cross
const sizeBase = Math.max(step, Math.ceil((100 / priceDeep) / step) * step); // clear the ~100 USDT0 min-notional
console.log(`market pid=${PID} ${sym} oracle=${oracle} deepBid=${priceDeep} size=${sizeBase} tick=${tick}`);

const placeOne = async () => {
  const nonce = getOrderNonce();
  const order = { subaccountOwner: addr, subaccountName: SUBACCT, price: String(Math.round(priceDeep)), amount: String(BigInt(Math.round(sizeBase * 1e18))), expiration: String(Math.floor(Date.now() / 1000) + 300), appendix: packOrderAppendix({ orderExecutionType: "post_only" }).toString() };
  const res = await engine.placeOrder({ productId: PID, order, nonce, verifyingAddr: getOrderVerifyingAddress(PID), chainId: CHAIN_ID });
  return res?.digest ?? res?.orderDigest ?? res?.data?.digest;
};
const cancelOne = (digest) => engine.cancelOrders({ subaccountOwner: addr, subaccountName: SUBACCT, productIds: [PID], digests: [digest], verifyingAddr: deploy.endpoint, chainId: CHAIN_ID });

const results = [];
let lastClean = 0, ceilingRate = 0, ceilingErr = "";
const openDigests = new Set();
outer: for (const rate of RATES) {
  const n = Math.max(1, Math.round((rate * WINDOW_MS) / 1000));
  const spacing = WINDOW_MS / n;
  let placeOk = 0, placeErr = 0, cancelOk = 0, cancelErr = 0, firstErr = "";
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    let digest;
    try { digest = await placeOne(); placeOk++; if (digest) openDigests.add(digest); }
    catch (e) { placeErr++; firstErr ||= `place: ${e.message}`; if (is429(e.message)) { ceilingErr = firstErr; break; } }
    if (digest) { try { await cancelOne(digest); cancelOk++; openDigests.delete(digest); } catch (e) { cancelErr++; firstErr ||= `cancel: ${e.message}`; if (is429(e.message)) { ceilingErr = firstErr; break; } } }
    const due = t0 + (i + 1) * spacing; const now = Date.now(); if (now < due) await sleep(due - now);
  }
  const elapsed = (Date.now() - t0) / 1000;
  const row = { targetRate: rate, pairs: n, placeOk, placeErr, cancelOk, cancelErr, effPairRate: +(placeOk / elapsed).toFixed(1), firstErr };
  results.push(row); console.log(`  rate≈${rate}/s → ${J(row)}`);
  if (placeErr > 0 || cancelErr > 0) { ceilingRate = rate; ceilingErr ||= firstErr; console.log(`  ⚠ first error at ≈${rate}/s — backing off (no further stepping).`); break outer; }
  lastClean = rate;
}

// cleanup: cancel any leftover, report any accrued position
for (const d of openDigests) { try { await cancelOne(d); } catch { /* ignore */ } }
const sum = await engine.getSubaccountSummary({ subaccountOwner: addr, subaccountName: SUBACCT }).catch(() => ({}));
const pos = (sum.balances ?? []).find((b) => Number(b.productId) === PID);
const posX18 = pos ? (pos.amount?.toFixed ? pos.amount.toFixed(0) : String(pos.amount)) : "0";

console.log(`\n=== CALIBRATION RESULT ===`);
console.log(`  highest CLEAN place+cancel rate: ≈${lastClean}/s  (ceiling hit at ≈${ceilingRate}/s: ${ceilingErr || "n/a"})`);
console.log(`  accrued ${sym} position after calibration: ${posX18} (expect 0 — deep post-only, cancelled)`);
console.log(`  → suggested registerNadoWriteBuckets: placeCapacity≈${lastClean}, placeWindowMs=1000, restCapacity≈${lastClean}, restWindowMs=1000 (conservative = highest clean spaced rate)`);
console.log(J({ market: { PID, sym, oracle }, lastCleanRate: lastClean, ceilingRate, ceilingErr, accruedPosX18: posX18, steps: results }));
process.exit(0);
