// =============================================================================
// THROWAWAY SPIKE — authenticated `order_update` WebSocket subscription probe.
// NOT production; NOT wired into the console or the keyless relay. It exists to
// reproduce the RE finding in docs/re/order-update-ws-auth.md on Ink testnet.
//
// What it proves: the `/subscribe` socket's `order_update` stream is unlocked by a
// single in-tab-signable `authenticate` frame carrying an EIP-712 signature over
// StreamAuthentication(bytes32 sender, uint64 expiration) — server stays keyless.
//
// Signs with the disposable wative workspace key (~/.nado-ika-testnet), in memory,
// NEVER printed. Hard-gated on NADO_LIVE. By default it only authenticates +
// subscribes + listens (touches no funds). Set PROBE_TRADE=1 to additionally place
// a post_only maker order and cancel it, to force real `placed`/`cancelled` frames.
//
//   NADO_LIVE=1 node packages/adapter-nado/scripts/order-update-probe.mjs
//   NADO_LIVE=1 PROBE_TRADE=1 PRODUCT_ID=2 node .../order-update-probe.mjs
// =============================================================================
import "wative-core/node";
import { Workspace } from "wative-core";
import { createWalletClient, createPublicClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EngineClient } from "@nadohq/engine-client";
import { NADO_DEPLOYMENTS, CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS, ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS, subaccountToHex, getOrderNonce, getOrderVerifyingAddress, packOrderAppendix } from "@nadohq/client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

if (!(process.env.NADO_LIVE === "1" || process.env.NADO_LIVE === "true")) {
  console.error("NADO_LIVE unset — refusing to hit the live sequencer."); process.exit(2);
}
const CHAIN_ID = 763373;
const ENV = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID];
const deploy = NADO_DEPLOYMENTS[ENV];
const engineUrl = ENGINE_CLIENT_ENDPOINTS[ENV];
const wsUrl = ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS[ENV];
const rpc = process.env.INK_TESTNET_RPC || "https://rpc-gel-sepolia.inkonchain.com";
const SUBACCT = "default";
const DO_TRADE = process.env.PROBE_TRADE === "1" || process.env.PROBE_TRADE === "true";

// ---- unlock the disposable wative workspace; key stays in memory, never printed ----
const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-testnet", "credentials.json"), "utf8"));
const wsp = await Workspace.open({ path: cred.workspacePath, password: cred.password });
const acc = wsp.accounts[0];
await acc.tryUnlock(cred.password);
let pk = acc.wallets[0].dumpPrivateKey("evm");
if (!pk.startsWith("0x")) pk = "0x" + pk;
await wsp.lock();

const chain = defineChain({ id: CHAIN_ID, name: "Ink Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const account = privateKeyToAccount(pk);
const walletClient = createWalletClient({ account, chain, transport: http(rpc) });
const pub = createPublicClient({ chain, transport: http(rpc) });
const engine = new EngineClient({ url: engineUrl, walletClient });
const addr = account.address;
const sender = subaccountToHex({ subaccountOwner: addr, subaccountName: SUBACCT });
console.log(`wallet=${addr} | env=${ENV} | endpoint=${deploy.endpoint} | trade=${DO_TRADE}`);
console.log(`sender(subaccount)=${sender}`);

// ---- build + sign the StreamAuthentication EIP-712 (expiration in MS, <=100s ahead) ----
// Production note: this exact typed-data sign is what wative-core performs IN-TAB; here we
// use viem's signTypedData (byte-equal to the Nado SDK, proven wave 1a) as a stand-in.
function buildStreamAuth() {
  const expiration = String(Date.now() + 60_000); // milliseconds; must be future & <=100s ahead
  return walletClient.signTypedData({
    account,
    domain: { name: "Nado", version: "0.0.1", chainId: CHAIN_ID, verifyingContract: deploy.endpoint },
    types: { StreamAuthentication: [ { name: "sender", type: "bytes32" }, { name: "expiration", type: "uint64" } ] },
    primaryType: "StreamAuthentication",
    message: { sender, expiration: BigInt(expiration) },
  }).then((signature) => ({ expiration, signature }));
}

const orderUpdates = [];
let authed = false, subbed = false;
const ws = new WebSocket(wsUrl);
let id = 1; const send = (m) => { m.id = id++; ws.send(JSON.stringify(m)); return m.id; };
let authId, subId;

ws.onopen = async () => {
  console.log("WS OPEN", wsUrl);
  const { expiration, signature } = await buildStreamAuth();
  console.log(`-> authenticate (expiration ms=${expiration}, sig ${signature.length} chars)`);
  authId = send({ method: "authenticate", tx: { sender, expiration }, signature });
};
ws.onmessage = async (ev) => {
  let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
  if (m.id === authId) {
    if (m.error) { console.log("AUTH FAILED:", m.error); try { ws.close(); } catch {}; process.exit(1); }
    console.log("AUTH OK:", JSON.stringify(m)); authed = true;
    subId = send({ method: "subscribe", stream: { type: "order_update", subaccount: sender } });
    return;
  }
  if (m.id === subId) {
    if (m.error) { console.log("order_update SUBSCRIBE FAILED:", m.error); try { ws.close(); } catch {}; process.exit(1); }
    console.log("order_update SUBSCRIBED:", JSON.stringify(m)); subbed = true;
    if (DO_TRADE) await placeAndCancel(); else console.log("(listening; set PROBE_TRADE=1 to force a frame)");
    return;
  }
  if (m.type === "order_update") { orderUpdates.push(m); console.log("order_update FRAME:", JSON.stringify(m)); }
};
ws.onerror = (e) => { console.log("WS ERROR", e?.message ?? String(e)); };
ws.onclose = (e) => { console.log("WS CLOSE", e.code, e.reason || ""); };

// Optional: place a resting post_only maker order then cancel it → emits placed/cancelled frames.
async function placeAndCancel() {
  try {
    const pid = Number(process.env.PRODUCT_ID || 2);
    const x18 = (v) => { try { return BigInt(String(v).split(".")[0]); } catch { return 0n; } };
    const mp = await engine.getMarketPrice({ productId: pid });
    const bid = x18(mp.bid), ask = x18(mp.ask), mark = x18(mp.markPrice ?? mp.indexPrice ?? mp.price ?? 0);
    const mid = mark > 0n ? mark : (bid > 0n && ask > 0n ? (bid + ask) / 2n : 0n);
    if (mid === 0n) { console.log("no price; skipping trade"); return; }
    const market = (await engine.getAllMarkets()).find((m) => m.productId === pid);
    const minSize = BigInt(market.minSize);
    const tick = BigInt(market.priceIncrement || "1") || 1n;
    let priceX18 = (mid * 90n) / 100n; priceX18 = (priceX18 / tick) * tick || tick; // 90% of oracle → rests as maker
    const nonce = getOrderNonce();
    const orderExp = BigInt(Math.floor(Date.now() / 1000) + 600).toString(); // seconds here (order expiry != auth expiration)
    const appendix = packOrderAppendix({ orderExecutionType: "post_only" }).toString();
    const order = { subaccountOwner: addr, subaccountName: SUBACCT, price: priceX18.toString(), amount: minSize.toString(), expiration: orderExp, appendix };
    console.log(`-> place post_only BUY product ${pid} size ${Number(minSize) / 1e18} price ${Number(priceX18) / 1e18}`);
    const res = await engine.placeOrder({ productId: pid, order, nonce, verifyingAddr: getOrderVerifyingAddress(pid), chainId: CHAIN_ID }).catch((e) => ({ err: e.message }));
    const digest = res?.digest ?? res?.orderDigest ?? res?.data?.digest;
    console.log("   placeOrder digest:", digest, res?.err ? `(err ${res.err})` : "");
    await new Promise((r) => setTimeout(r, 1500));
    if (digest) {
      const cancel = await engine.cancelOrders({ subaccountOwner: addr, subaccountName: SUBACCT, productIds: [pid], digests: [digest], verifyingAddr: deploy.endpoint, chainId: CHAIN_ID }).catch((e) => ({ err: e.message }));
      console.log("   cancelOrders:", cancel?.err ? `err ${cancel.err}` : "ok");
    }
  } catch (e) { console.log("placeAndCancel error:", e.message); }
}

const LISTEN_MS = Number(process.env.PROBE_LISTEN_MS || (DO_TRADE ? 12000 : 8000));
setTimeout(() => {
  console.log(`\n=== RESULT === authed=${authed} order_update_subscribed=${subbed} frames=${orderUpdates.length}`);
  try { ws.close(); } catch {}
  process.exit(authed && subbed ? 0 : 3);
}, LISTEN_MS);
