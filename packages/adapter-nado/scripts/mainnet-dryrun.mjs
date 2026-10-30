// Nado Ink-MAINNET dry-run — READ ONLY. No private key, no funds, no writes, no orders.
// M1 of the gated mainnet capacity run: confirm the sequencer is reachable, that a stable
// mid-spread market exists, and read per-market min-notional / sizeIncrement / tick + any
// fee / margin (IMF) the engine exposes, to size funding and sanity-check the ~$25 stop.
// Mirrors scripts/testnet-preflight.mjs but for chainId 57073. Nothing is ever placed.
//
//   node packages/adapter-nado/scripts/mainnet-dryrun.mjs
import { EngineClient } from "@nadohq/engine-client";
import { CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS, NADO_DEPLOYMENTS } from "@nadohq/client";

const CHAIN_ID = Number(process.env.NADO_CHAIN_ID ?? 57073); // Ink mainnet
const env = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID];
const engineUrl = env ? ENGINE_CLIENT_ENDPOINTS[env] : undefined;
const deploy = env ? NADO_DEPLOYMENTS[env] : undefined;
const fx = (v) => (v == null ? NaN : typeof v === "object" && v.toFixed ? Number(v.toFixed()) : Number(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

console.log(`Nado MAINNET dry-run (READ ONLY)  env=${env} chainId=${CHAIN_ID}`);
console.log(`  sequencer REST : ${engineUrl}`);
if (!env || !engineUrl) {
  console.log("  🚨 no mainnet env/endpoint resolved for this chainId — SDK may not expose mainnet. Nothing done (read-only).");
  process.exit(2);
}
console.log(`  endpoint(deposit): ${deploy?.endpoint}  clearinghouse: ${deploy?.clearinghouse}`);

const ec = new EngineClient({ url: engineUrl });
const status = await ec.getStatus().catch((e) => `ERR ${e.message}`);
console.log(`  sequencer status: ${J(status)}`);

// ---- shapes (dump keys so we read the real field names, not guess) --------------------------
const markets = await ec.getAllMarkets().catch((e) => { console.log(`  getAllMarkets ERR ${e.message}`); return []; });
console.log(`\n  markets: ${Array.isArray(markets) ? markets.length : "?"}`);
if (Array.isArray(markets) && markets[0]) {
  console.log(`  market[0] keys: ${Object.keys(markets[0]).join(",")}`);
  console.log(`  market[0] sample: ${J(markets[0]).slice(0, 500)}`);
}

const symResp = await ec.getSymbols({}).catch((e) => { console.log(`  getSymbols ERR ${e.message}`); return {}; });
const symbols = symResp.symbols ?? symResp ?? {};
const symList = Object.values(symbols);
console.log(`\n  symbols: ${symList.length}`);
if (symList[0]) {
  console.log(`  symbol[0] keys: ${Object.keys(symList[0]).join(",")}`);
  console.log(`  symbol[0] sample: ${J(symList[0]).slice(0, 400)}`);
}

// pid -> market sizing facts
const byPid = new Map();
for (const s of symList) {
  const pid = s.productId ?? s.product_id;
  if (pid == null) continue;
  byPid.set(Number(pid), {
    symbol: s.symbol ?? String(pid),
    tick: fx(s.priceIncrement),
    sizeIncrementX18: s.sizeIncrement != null ? String(fx(s.sizeIncrement)) : "?",
    minNotionalX18: s.minSize != null ? String(fx(s.minSize)) : "?",
    minNotionalUSDT: s.minSize != null ? fx(s.minSize) / 1e18 : NaN,
  });
}

// ---- spread snapshot across all markets -----------------------------------------------------
console.log(`\n  scanning top-of-book spread across ${byPid.size} markets (throttled, read-only)…`);
const rows = [];
for (const [pid, m] of byPid) {
  if (!(m.tick > 0)) continue;
  const liq = await ec.getMarketLiquidity({ productId: pid, depth: 1 }).catch(() => null);
  await sleep(55); // ~18/s, under the 28/s read budget
  if (!liq) continue;
  const bb = fx(liq.bids?.[0]?.price ?? liq.bids?.[0]?.[0]);
  const ba = fx(liq.asks?.[0]?.price ?? liq.asks?.[0]?.[0]);
  if (!(bb > 0) || !(ba > 0)) continue;
  const spreadT = Math.round((ba - bb) / m.tick);
  const midPx = (bb + ba) / 2;
  rows.push({ pid, symbol: m.symbol, tick: m.tick, spreadT, bb, ba, midPx,
    minNotionalUSDT: m.minNotionalUSDT });
}
rows.sort((a, b) => b.spreadT - a.spreadT);
console.log(`  markets with a live 2-sided book: ${rows.length}`);
console.log(`\n  TOP spread candidates (wider = more room to improve the touch cleanly):`);
for (const r of rows.slice(0, 12)) {
  console.log(`    ${String(r.symbol).padEnd(16)} pid=${String(r.pid).padStart(3)} spread=${String(r.spreadT).padStart(4)}t  mid≈${r.midPx}  tick=${r.tick}  minNotional≈$${r.minNotionalUSDT}`);
}

// ---- stability sample of the top candidates -------------------------------------------------
const top = rows.filter((r) => r.spreadT >= 2).slice(0, 8);
if (top.length) {
  console.log(`\n  stability sample (${top.length} candidates, 4 reads over ~16s — looking for a spread that STAYS >=2–3t):`);
  const track = new Map(top.map((r) => [r.pid, { symbol: r.symbol, tick: r.tick, spreads: [r.spreadT] }]));
  for (let i = 0; i < 3; i++) {
    await sleep(5000);
    for (const [pid, t] of track) {
      const liq = await ec.getMarketLiquidity({ productId: pid, depth: 1 }).catch(() => null);
      await sleep(55);
      const bb = fx(liq?.bids?.[0]?.price ?? liq?.bids?.[0]?.[0]);
      const ba = fx(liq?.asks?.[0]?.price ?? liq?.asks?.[0]?.[0]);
      t.spreads.push(bb > 0 && ba > 0 ? Math.round((ba - bb) / t.tick) : 0);
    }
  }
  for (const [pid, t] of track) {
    const mn = Math.min(...t.spreads), mx = Math.max(...t.spreads);
    const stable = mn >= 2;
    console.log(`    ${String(t.symbol).padEnd(16)} pid=${String(pid).padStart(3)} spreads=[${t.spreads.join(",")}]t  min=${mn} max=${mx}  ${stable ? "✓ stable >=2t" : "✗ dips below 2t"}`);
  }
} else {
  console.log(`\n  ⚠ no market currently shows a >=2-tick spread — a clean improve-the-touch self-cross needs one; re-sample or widen the window.`);
}

console.log(`\n=== dry-run complete (read-only; no funds, no orders, no keys) ===`);
