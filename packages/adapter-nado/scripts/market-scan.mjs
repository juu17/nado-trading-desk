// Read-only: scan ALL markets for a deterministic-self-cross candidate. Reports, per live perp,
// the top-of-book spread in ticks and whether the book is empty — so we can pick a market where
// A's post-only maker can sit strictly at top-of-book and B's IOC crosses ONLY A. Testnet only.
//   node packages/adapter-nado/scripts/market-scan.mjs
import { EngineClient } from "@nadohq/engine-client";
import { CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS } from "@nadohq/client";

const CHAIN_ID = 763373;
const ENV = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID];
const engine = new EngineClient({ url: ENGINE_CLIENT_ENDPOINTS[ENV] });
const fx = (v) => (v == null ? undefined : typeof v === "object" && v.toFixed ? Number(v.toFixed()) : Number(v));

const markets = await engine.getAllMarkets();
const syms = (await engine.getSymbols({})).symbols ?? {};
const symByPid = new Map(Object.values(syms).map((s) => [s.productId, s]));
const perps = markets.filter((m) => m.productId !== 0);

const rows = [];
for (const m of perps) {
  const pid = m.productId;
  const sym = symByPid.get(pid);
  const tick = sym ? fx(sym.priceIncrement) : undefined;
  let bid, ask, bids = 0, asks = 0, mpOk = false;
  try {
    const liq = await engine.getMarketLiquidity({ productId: pid, depth: 1 });
    bids = liq?.bids?.length ?? 0; asks = liq?.asks?.length ?? 0;
    bid = fx(liq?.bids?.[0]?.price); ask = fx(liq?.asks?.[0]?.price);
  } catch { /* skip */ }
  try { await engine.getMarketPrice({ productId: pid }); mpOk = true; } catch { mpOk = false; }
  const spreadTicks = (bid && ask && tick) ? Math.round((ask - bid) / tick) : undefined;
  rows.push({ pid, symbol: m.symbol ?? sym?.symbol ?? "", bids, asks, bid, ask, tick, spreadTicks, mpOk, empty: bids + asks === 0 });
}

const liveEmpty = rows.filter((r) => r.empty && r.mpOk);
const wide = rows.filter((r) => r.spreadTicks != null && r.mpOk).sort((a, b) => b.spreadTicks - a.spreadTicks);
console.log(`scanned ${rows.length} perps`);
console.log(`\n[empty-book + live oracle] (ideal — A rests, B crosses only A):`);
console.log(liveEmpty.length ? liveEmpty.map((r) => `  pid=${r.pid} ${r.symbol} tick=${r.tick} mpOk`).join("\n") : "  (none)");
console.log(`\n[widest spreads, live] top 12 (need >=2 ticks to insert A strictly inside):`);
for (const r of wide.slice(0, 12)) console.log(`  pid=${r.pid} ${r.symbol} spread=${r.spreadTicks}t bid=${r.bid} ask=${r.ask} tick=${r.tick}`);
console.log(`\n[spread histogram] ` + Object.entries(wide.reduce((h, r) => { h[r.spreadTicks] = (h[r.spreadTicks] ?? 0) + 1; return h; }, {})).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}t:${v}`).join("  "));
process.exit(0);
