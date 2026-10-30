// Cleanup after the terminated N=1 run that left B2 non-flat on ASTER-PERP (the taker crossed
// external liquidity, not A, so A's maker went unfilled and the pair paused LOOKUP_UNKNOWN before
// the close could run). Reads A + B2 position and open orders on pid 48; with FLATTEN=1 cancels
// any resting A/B2 orders and closes any position REDUCE-ONLY (IOC) into the liquid book, then
// re-reads to prove flat. Touches ONLY A (index 0) and B2 (index 2) on ASTER — never B / BTC.
//   NADO_LIVE-gated.  read-only:  node packages/adapter-nado/scripts/aster-cleanup.mjs
//                     act:        NADO_LIVE=1 FLATTEN=1 node packages/adapter-nado/scripts/aster-cleanup.mjs
import "wative-core/node";
import { Workspace } from "wative-core";
import { createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EngineClient } from "@nadohq/engine-client";
import { CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS, NADO_DEPLOYMENTS, getOrderNonce, getOrderVerifyingAddress, packOrderAppendix } from "@nadohq/client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const PID = Number(process.env.AB_PRODUCT_ID ?? 48);
const ACT = process.env.FLATTEN === "1" && (process.env.NADO_LIVE === "1" || process.env.NADO_LIVE === "true");
const CHAIN_ID = 763373, ENV = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID], deploy = NADO_DEPLOYMENTS[ENV];
const engineUrl = ENGINE_CLIENT_ENDPOINTS[ENV];
const rpc = process.env.INK_TESTNET_RPC || "https://rpc-gel-sepolia.inkonchain.com";
const fx = (v) => (v == null ? NaN : v.toFixed ? Number(v.toFixed()) : Number(v));
const big = (v) => { try { return BigInt((v?.toFixed ? v.toFixed(0) : String(v)).split(".")[0] || "0"); } catch { return 0n; } };
const engine = new EngineClient({ url: engineUrl });
const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-testnet", "credentials.json"), "utf8"));
const roleIndex = { A: 0, B2: (cred.wallets?.find((w) => w.role === "B2") ?? {}).index ?? 2 };
const sym = (await engine.getSymbols({})).symbols ?? {};
const s = Object.values(sym).find((x) => x.productId === PID);
const tick = fx(s?.priceIncrement) || 0, tickDec = (String(s?.priceIncrement).split(".")[1] || "").length;

const ws = await Workspace.open({ path: cred.workspacePath, password: cred.password });
const acc = ws.accounts[0]; await acc.tryUnlock(cred.password);
const pkOf = (i) => { let k = acc.getWalletList()[i].dumpPrivateKey("evm"); return k.startsWith("0x") ? k : "0x" + k; };
const keys = { A: pkOf(roleIndex.A), B2: pkOf(roleIndex.B2) };
await ws.lock();
const chain = defineChain({ id: CHAIN_ID, name: "Ink Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });

const posOf = async (addr) => { const sum = await engine.getSubaccountSummary({ subaccountOwner: addr, subaccountName: "default" }); const b = (sum.balances ?? []).find((x) => Number(x.productId) === PID); return b ? big(b.amount) : 0n; };
const ordersOf = async (addr) => { try { const o = await engine.getSubaccountOrders({ subaccountOwner: addr, subaccountName: "default", productId: PID }); return o?.orders ?? o ?? []; } catch { return []; } };

const liq = await engine.getMarketLiquidity({ productId: PID, depth: 1 }).catch(() => ({ bids: [], asks: [] }));
const bestBid = fx(liq.bids?.[0]?.price), bestAsk = fx(liq.asks?.[0]?.price);
console.log(`ASTER-ish pid=${PID} tick=${tick} topBid=${bestBid} topAsk=${bestAsk} act=${ACT}`);

for (const role of ["A", "B2"]) {
  const account = privateKeyToAccount(keys[role]);
  const addr = account.address;
  const engineW = new EngineClient({ url: engineUrl, walletClient: createWalletClient({ account, chain, transport: http(rpc) }) });
  const posX18 = await posOf(addr); const pos = Number(posX18) / 1e18;
  const open = await ordersOf(addr);
  console.log(`\n${role} ${addr}: pos(pid ${PID})=${pos}  openOrders=${Array.isArray(open) ? open.length : 0}`);
  if (!ACT) continue;
  // 1) cancel any resting orders on this market
  const digests = (Array.isArray(open) ? open : []).map((o) => o.digest ?? o.orderDigest).filter(Boolean);
  if (digests.length) { await engineW.cancelOrders({ subaccountOwner: addr, subaccountName: "default", productIds: [PID], digests, verifyingAddr: deploy.endpoint, chainId: CHAIN_ID }).then(() => console.log(`  cancelled ${digests.length} order(s)`)).catch((e) => console.log(`  cancel err: ${(e.message||"").slice(0,120)}`)); }
  // 2) flatten any position REDUCE-ONLY IOC, crossing the book
  if (posX18 !== 0n) {
    const long = posX18 > 0n; const px = long ? bestBid * (1 - 0.01) : bestAsk * (1 + 0.01);
    const pxAligned = (long ? Math.floor(px / tick) : Math.ceil(px / tick)) * tick;
    const amt = long ? -(posX18 < 0n ? -posX18 : posX18) : (posX18 < 0n ? -posX18 : posX18); // SELL(neg) if long, BUY(pos) if short
    const order = { subaccountOwner: addr, subaccountName: "default", price: pxAligned.toFixed(tickDec), amount: amt.toString(), expiration: String(Math.floor(Date.now() / 1000) + 120), appendix: packOrderAppendix({ orderExecutionType: "ioc", reduceOnly: true }).toString() };
    try { await engineW.placeOrder({ productId: PID, order, nonce: getOrderNonce(), verifyingAddr: getOrderVerifyingAddress(PID), chainId: CHAIN_ID }); console.log(`  reduce-only ${long ? "SELL" : "BUY"} ${Math.abs(pos)} @ ${order.price} sent`); }
    catch (e) { console.log(`  flatten err: ${(e.message || "").slice(0, 140)}`); }
  }
}
if (ACT) {
  await new Promise((r) => setTimeout(r, 2500));
  const pa = Number(await posOf(privateKeyToAccount(keys.A).address)) / 1e18, pb = Number(await posOf(privateKeyToAccount(keys.B2).address)) / 1e18;
  console.log(`\nAFTER: A pos=${pa}  B2 pos=${pb}  flat=${pa === 0 && pb === 0}`);
}
process.exit(0);
