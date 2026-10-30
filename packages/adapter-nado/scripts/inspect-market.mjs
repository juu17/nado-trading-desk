// One-off read-only: dump the getAllMarkets entry + getMarketPrice + a summary oraclePrice for a
// product, to find the oracle/mark field for an empty-book perp. node .../inspect-market.mjs 60
import { EngineClient } from "@nadohq/engine-client";
import { CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS } from "@nadohq/client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const PID = Number(process.argv[2] || 60);
const e = new EngineClient({ url: ENGINE_CLIENT_ENDPOINTS[CHAIN_ID_TO_CHAIN_ENV[763373]] });
const J = (v) => JSON.stringify(v, (_k, x) => (x?.toFixed ? x.toFixed() : x));
const markets = await e.getAllMarkets();
const m = markets.find((x) => x.productId === PID);
console.log(`getAllMarkets[${PID}] keys=${Object.keys(m ?? {}).join(",")}`);
console.log(`  = ${J(m)}`);
const mp = await e.getMarketPrice({ productId: PID }).catch((z) => ({ err: z.message }));
console.log(`getMarketPrice[${PID}] keys=${Object.keys(mp ?? {}).join(",")} = ${J(mp)}`);
const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-testnet", "credentials.json"), "utf8"));
const A = (cred.wallets?.find((w) => w.role === "A") ?? { address: cred.address }).address;
const sum = await e.getSubaccountSummary({ subaccountOwner: A, subaccountName: "default" });
const bal = (sum.balances ?? []).find((b) => Number(b.productId) === PID);
console.log(`summary balance[${PID}] keys=${Object.keys(bal ?? {}).join(",")} oraclePrice=${J(bal?.oraclePrice)}`);
process.exit(0);
