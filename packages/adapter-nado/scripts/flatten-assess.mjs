// Read-only: assess the flatten feasibility. Fresh A/B positions on BTC (pid 2) + WETH (pid 3),
// and the book depth within the ~±20% price band — bid-side size (for B to SELL its long) and
// ask-side size (for A to BUY to cover its short) — so we know how much can be flattened per
// IOC within the band, and how much the A<->B overlap cross can net with no book impact.
//   node packages/adapter-nado/scripts/flatten-assess.mjs
import { EngineClient } from "@nadohq/engine-client";
import { CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS } from "@nadohq/client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const e = new EngineClient({ url: ENGINE_CLIENT_ENDPOINTS[CHAIN_ID_TO_CHAIN_ENV[763373]] });
const fx = (v) => (v == null ? NaN : v.toFixed ? Number(v.toFixed()) : Number(v));
const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-testnet", "credentials.json"), "utf8"));
const A = (cred.wallets?.find((w) => w.role === "A") ?? { address: cred.address }).address;
const B = (cred.wallets?.find((w) => w.role === "B") ?? {}).address;
const big = (v) => { try { return BigInt((v?.toFixed ? v.toFixed(0) : String(v)).split(".")[0] || "0"); } catch { return 0n; } };
const markets = await e.getAllMarkets();
const oracleOf = (pid) => fx(markets.find((m) => Number(m.productId) === pid)?.product?.oraclePrice);

const posOf = async (addr, pid) => {
  const sum = await e.getSubaccountSummary({ subaccountOwner: addr, subaccountName: "default" });
  const b = (sum.balances ?? []).find((x) => Number(x.productId) === pid);
  return b ? Number(big(b.amount)) / 1e18 : 0;
};
for (const pid of [2, 3]) {
  const oracle = oracleOf(pid);
  const pa = await posOf(A, pid), pb = await posOf(B, pid);
  const liq = await e.getMarketLiquidity({ productId: pid, depth: 200 }).catch(() => ({ bids: [], asks: [] }));
  const lo = oracle * 0.8, hi = oracle * 1.2;
  const bidsInBand = (liq.bids ?? []).filter((l) => fx(l.price) >= lo).reduce((s, l) => s + fx(l.liquidity) / 1e18, 0);
  const asksInBand = (liq.asks ?? []).filter((l) => fx(l.price) <= hi).reduce((s, l) => s + fx(l.liquidity) / 1e18, 0);
  const sym = pid === 2 ? "BTC-PERP" : "WETH";
  console.log(`\npid=${pid} ${sym} oracle=${oracle} band=[${lo.toFixed(2)},${hi.toFixed(2)}]`);
  console.log(`  A pos=${pa}  B pos=${pb}`);
  console.log(`  book: bid-side size in band=${bidsInBand.toFixed(4)} (B sells into this)  ask-side size in band=${asksInBand.toFixed(4)} (A buys into this)`);
  console.log(`  bids levels=${liq.bids?.length ?? 0} asks levels=${liq.asks?.length ?? 0}  top bid=${fx(liq.bids?.[0]?.price)} top ask=${fx(liq.asks?.[0]?.price)}`);
  const overlap = Math.min(Math.abs(pa), Math.abs(pb)) * (Math.sign(pa) !== Math.sign(pb) && pa !== 0 && pb !== 0 ? 1 : 0);
  if (pid === 2) console.log(`  A<->B overlap crossable (opposite signs): ${overlap.toFixed(4)} BTC  → B remainder to book after: ${(Math.abs(pb) - overlap).toFixed(4)}`);
}
process.exit(0);
