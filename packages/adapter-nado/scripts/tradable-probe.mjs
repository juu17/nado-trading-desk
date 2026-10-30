// Find a TRADABLE flat market right now: equity perps are TRADING_STOPPED off-hours (weekends),
// so the N=1 baseline needs a 24/7 crypto perp that actually accepts an order. For each candidate
// (+ a scan of all perps' symbols), place a TINY deep post-only maker via A (won't cross/fill),
// read the result (accepted = tradable / an error code = stopped/blocked), and cancel. Read-only
// to positions; places only tiny deep orders that are immediately cancelled. NADO_LIVE-gated.
//   NADO_LIVE=1 node packages/adapter-nado/scripts/tradable-probe.mjs
import "wative-core/node";
import { Workspace } from "wative-core";
import { createWalletClient, http, defineChain, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EngineClient } from "@nadohq/engine-client";
import { CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS, NADO_DEPLOYMENTS, getOrderNonce, getOrderVerifyingAddress, packOrderAppendix } from "@nadohq/client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
if (!(process.env.NADO_LIVE === "1" || process.env.NADO_LIVE === "true")) { console.error("NADO_LIVE unset"); process.exit(2); }
const CHAIN_ID = 763373, ENV = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID], deploy = NADO_DEPLOYMENTS[CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID]];
const engineUrl = ENGINE_CLIENT_ENDPOINTS[ENV];
const rpc = process.env.INK_TESTNET_RPC || "https://rpc-gel-sepolia.inkonchain.com";
const fx = (v) => (v == null ? NaN : v.toFixed ? Number(v.toFixed()) : Number(v));
const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-testnet", "credentials.json"), "utf8"));
const ws = await Workspace.open({ path: cred.workspacePath, password: cred.password });
const acc = ws.accounts[0]; await acc.tryUnlock(cred.password);
let pk = acc.getWalletList()[0].dumpPrivateKey("evm"); if (!pk.startsWith("0x")) pk = "0x" + pk;
await ws.lock();
const chain = defineChain({ id: CHAIN_ID, name: "Ink Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const account = privateKeyToAccount(pk);
const engine = new EngineClient({ url: engineUrl, walletClient: createWalletClient({ account, chain, transport: http(rpc) }) });
const addr = account.address;

const markets = await engine.getAllMarkets();
const syms = (await engine.getSymbols({})).symbols ?? {};
const symByPid = new Map(Object.values(syms).map((s) => [s.productId, s]));
// crypto-looking perps (exclude equity w*x / known equities) + the explicit candidates
const EQUITY = /^(w[A-Z]|MSTR|NBIS|HIMS|LLY|ORCL|SKHY|PONS|COIN|TSLA|NVDA|AAPL|META|AMZN|GOOGL|SPY|QQQ|AMD|MSFT)/i;
const list = process.env.PIDS ? process.env.PIDS.split(",").map(Number)
  : markets.map((m) => m.productId).filter((pid) => pid !== 0 && !EQUITY.test(symByPid.get(pid)?.symbol ?? "x"));
console.log(`probing ${list.length} non-equity perps for tradability (A=${addr})`);
const tradable = [];
for (const pid of list) {
  const s = symByPid.get(pid); if (!s) continue;
  const mkt = markets.find((m) => Number(m.productId) === pid);
  const oracle = fx(mkt?.product?.oraclePrice); const tick = fx(s.priceIncrement);
  if (!(oracle > 0)) { console.log(`  pid=${pid} ${s.symbol}: no oracle, skip`); continue; }
  const liq = await engine.getMarketLiquidity({ productId: pid, depth: 1 }).catch(() => ({ bids: [], asks: [] }));
  const bb = fx(liq.bids?.[0]?.price), ba = fx(liq.asks?.[0]?.price);
  const spreadT = (bb > 0 && ba > 0 && tick > 0) ? Math.round((ba - bb) / tick) : 0;
  const dec = (String(tick).split(".")[1] || "").length;
  const pHuman = Math.round((oracle * 0.85) / tick) * tick; // deep, within band, won't cross; tick-aligned
  const priceHuman = pHuman.toFixed(dec); // the SDK order.price is HUMAN (converted to X18 internally)
  const stepX18 = BigInt(s.sizeIncrement.toFixed(0));
  const stepHuman = Number(stepX18) / 1e18;
  const steps = Math.max(1, Math.ceil((120 / pHuman) / stepHuman)); // clear ~120 USDT0 min-notional
  const amt = BigInt(steps) * stepX18; // amount is X18 base size
  const order = { subaccountOwner: addr, subaccountName: "default", price: priceHuman, amount: amt.toString(), expiration: String(Math.floor(Date.now() / 1000) + 120), appendix: packOrderAppendix({ orderExecutionType: "post_only" }).toString() };
  let verdict;
  try {
    const res = await engine.placeOrder({ productId: pid, order, nonce: getOrderNonce(), verifyingAddr: getOrderVerifyingAddress(pid), chainId: CHAIN_ID });
    const digest = res?.digest ?? res?.orderDigest ?? res?.data?.digest;
    verdict = "TRADABLE";
    if (digest) await engine.cancelOrders({ subaccountOwner: addr, subaccountName: "default", productIds: [pid], digests: [digest], verifyingAddr: deploy.endpoint, chainId: CHAIN_ID }).catch(() => {});
    tradable.push({ pid, symbol: s.symbol, spreadT, tick });
  } catch (e) { verdict = (e.message || "").slice(0, 70); }
  console.log(`  pid=${pid} ${s.symbol} spread=${spreadT}t → ${verdict}`);
}
console.log(`\nTRADABLE non-equity perps: ${tradable.map((t) => `${t.pid}:${t.symbol}(${t.spreadT}t)`).join("  ") || "(none)"}`);
console.log(`>=2-tick tradable right now: ${tradable.filter((t) => t.spreadT >= 2).map((t) => `${t.pid}:${t.symbol}`).join(", ") || "(none — spreads are 1t; the runner will poll)"}`);
process.exit(0);
