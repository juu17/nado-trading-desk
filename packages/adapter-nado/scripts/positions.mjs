// Read-only: dump every nonzero perp position for A and B, so we can pick a market where BOTH
// are flat (the Phase-A cohort-settle gate assumes a flat-start cohort). node .../positions.mjs
import { EngineClient } from "@nadohq/engine-client";
import { CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS } from "@nadohq/client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const e = new EngineClient({ url: ENGINE_CLIENT_ENDPOINTS[CHAIN_ID_TO_CHAIN_ENV[763373]] });
const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-testnet", "credentials.json"), "utf8"));
const wallets = cred.wallets ?? [{ role: "A", address: cred.address }];
const syms = (await e.getSymbols({})).symbols ?? {};
const symByPid = new Map(Object.values(syms).map((s) => [s.productId, s.symbol]));
const big = (v) => { try { return BigInt((v?.toFixed ? v.toFixed(0) : String(v)).split(".")[0] || "0"); } catch { return 0n; } };
for (const w of wallets) {
  const sum = await e.getSubaccountSummary({ subaccountOwner: w.address, subaccountName: "default" });
  const nz = (sum.balances ?? []).filter((b) => Number(b.productId) !== 0 && big(b.amount) !== 0n)
    .map((b) => `${b.productId}:${symByPid.get(Number(b.productId)) ?? "?"}=${(Number(big(b.amount)) / 1e18).toFixed(5)}`);
  console.log(`${w.role} ${w.address}\n  nonzero perps: ${nz.length ? nz.join("  ") : "(none — all flat)"}`);
}
process.exit(0);
