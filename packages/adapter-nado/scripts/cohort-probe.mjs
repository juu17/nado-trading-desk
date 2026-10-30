// Read-only + subscribe-only LIVE probe to pin the shapes the A/B round needs BEFORE placing
// any order (brief: "pin the fill-frame shape first"). NO key, NO writes. Confirms: market
// scan (thin/empty book + tick/step + oracle), the keyless public `fill` subscribe handshake,
// the getSubaccountSummary collateral/position shape, and the getOrder NOT-FOUND error shape
// (the #8 discriminator for isOrderNotFound). Testnet only.
//
//   node packages/adapter-nado/scripts/cohort-probe.mjs
import { EngineClient } from "@nadohq/engine-client";
import { CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS, ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS, subaccountToHex } from "@nadohq/client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CHAIN_ID = 763373;
const ENV = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID];
const engineUrl = ENGINE_CLIENT_ENDPOINTS[ENV];
const wsUrl = ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS[ENV];
const SUBACCT = "default";
const J = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const trunc = (s, n = 400) => (s && s.length > n ? s.slice(0, n) + "…" : s);

const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-testnet", "credentials.json"), "utf8"));
const A = (cred.wallets?.find((w) => w.role === "A") ?? { address: cred.address }).address;
const B = (cred.wallets?.find((w) => w.role === "B") ?? {}).address;
const engine = new EngineClient({ url: engineUrl });

console.log(`cohort-probe env=${ENV} chainId=${CHAIN_ID}\n  REST=${engineUrl}\n  WS(sub)=${wsUrl}\n  A=${A} B=${B}`);

// ---- 1. market scan: find thin/empty-book perps with sane tick/step ------------------------
const markets = await engine.getAllMarkets().catch((e) => ({ err: e.message }));
const list = Array.isArray(markets) ? markets : markets?.markets ?? [];
console.log(`\n[markets] count=${Array.isArray(list) ? list.length : "?"}`);
let symbols;
try { symbols = await engine.getSymbols({}); } catch (e) { symbols = { err: e.message }; }
const symArr = symbols?.symbols ? Object.values(symbols.symbols) : [];
console.log(`[symbols] count=${symArr.length}; sample=${trunc(J(symArr[0]))}`);

// probe book depth on the first ~12 perp products; report empty/thin ones
const perps = list.filter((m) => (m.type ?? m.productType) !== "spot" && m.productId !== 0).slice(0, 12);
const thin = [];
for (const m of perps) {
  const pid = m.productId;
  const liq = await engine.getMarketLiquidity({ productId: pid, depth: 5 }).catch((e) => ({ err: e.message }));
  const bids = liq?.bids?.length ?? 0, asks = liq?.asks?.length ?? 0;
  let price;
  try { const mp = await engine.getMarketPrice({ productId: pid }); price = J(mp).slice(0, 120); } catch (e) { price = "mp-err " + e.message; }
  const sym = symArr.find((s) => s.productId === pid);
  const tick = sym ? J(sym.priceIncrement) : "?", step = sym ? J(sym.sizeIncrement) : "?", min = sym ? J(sym.minSize) : "?";
  console.log(`  pid=${pid} ${m.symbol ?? ""} book[bids=${bids},asks=${asks}] tick=${tick} step=${step} minSize=${min} mp=${price}`);
  if (bids + asks === 0) thin.push(pid);
}
console.log(`[thin/empty-book perps] ${thin.join(", ") || "(none in sample)"}`);

// ---- 2. getOrder NOT-FOUND error shape (the #8 discriminator) -------------------------------
const bogus = "0x" + "f".repeat(64);
const scanPid = perps[0]?.productId ?? 2;
try {
  const o = await engine.getOrder({ productId: scanPid, digest: bogus });
  console.log(`\n[getOrder bogus] returned (not thrown): ${trunc(J(o))}`);
} catch (e) {
  console.log(`\n[getOrder bogus] THREW: name=${e?.name} message=${trunc(String(e?.message))}`);
  console.log(`  code=${J(e?.code)} status=${J(e?.status)} raw=${trunc(J(e?.raw ?? e?.data ?? e?.response))}`);
}

// ---- 3. getSubaccountSummary shape (collateral + any position) ------------------------------
try {
  const sum = await engine.getSubaccountSummary({ subaccountOwner: A, subaccountName: SUBACCT });
  const bals = sum?.balances ?? [];
  const quote = bals.find((b) => Number(b.productId) === 0);
  console.log(`\n[summary A] balances=${bals.length} quote(pid0)=${trunc(J(quote))}`);
  const nonzero = bals.filter((b) => { const a = b.amount ?? b.balance?.amount; try { return a && BigInt(String(a).split(".")[0]) !== 0n; } catch { return false; } });
  console.log(`  nonzero balances: ${nonzero.length}; sample=${trunc(J(nonzero[0]))}`);
} catch (e) { console.log(`\n[summary A] ERR ${e.message}`); }

// ---- 4. keyless public `fill` subscribe handshake (no auth frame) ---------------------------
const senderA = subaccountToHex({ subaccountOwner: A, subaccountName: SUBACCT });
console.log(`\n[fill subscribe] senderA=${senderA}`);
await new Promise((resolve) => {
  const ws = new WebSocket(wsUrl);
  let id = 1, subId;
  const done = (why) => { try { ws.close(); } catch {} console.log(`  done: ${why}`); resolve(); };
  const timer = setTimeout(() => done("timeout (no more frames)"), 6000);
  ws.onopen = () => { console.log("  WS open; -> subscribe fill (keyless, no authenticate)"); subId = id++; ws.send(JSON.stringify({ id: subId, method: "subscribe", stream: { type: "fill", subaccount: senderA } })); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.id === subId) { console.log(`  subscribe ack: ${m.error ? "ERROR " + J(m.error) : "OK " + trunc(J(m))}`); if (m.error) { clearTimeout(timer); done("subscribe rejected"); } return; }
    if (m.type === "fill") console.log(`  FILL FRAME: ${trunc(J(m))}`);
  };
  ws.onerror = (e) => { console.log(`  WS error: ${e?.message ?? e}`); };
  ws.onclose = (e) => { clearTimeout(timer); console.log(`  WS close ${e.code}`); };
});

console.log("\nprobe done (no orders placed).");
process.exit(0);
