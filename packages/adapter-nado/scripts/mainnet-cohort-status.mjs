// Read-only MAINNET cohort funding check — NO key, NO unlock, NO writes. Reads gas (ETH via RPC),
// USDT0 token balance (ERC20), and Nado collateral (getSubaccountSummary quote balance) for BOTH
// wallets in ~/.nado-ika-mainnet/credentials.json. Also dumps the deployment so we can locate the
// mainnet USDT0 / quote collateral token address (needed for the deposit's approve step). Decides,
// per wallet: READY (has collateral) / NEEDS-DEPOSIT (has USDT0, no collateral) / BLOCKED (neither).
//
//   node packages/adapter-nado/scripts/mainnet-cohort-status.mjs
import { EngineClient } from "@nadohq/engine-client";
import { CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS, NADO_DEPLOYMENTS } from "@nadohq/client";
import { createPublicClient, http, formatEther, formatUnits, isAddress } from "viem";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CHAIN_ID = 57073; // Ink mainnet
const ENV = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID];
const engineUrl = ENGINE_CLIENT_ENDPOINTS[ENV];
const rpc = process.env.INK_MAINNET_RPC || "https://rpc-gel.inkonchain.com";
const SUBACCT = "default";
const QUOTE_PRODUCT = 0;

const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];

const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-mainnet", "credentials.json"), "utf8"));
const wallets = cred.wallets ?? [{ role: "A", address: cred.address }, { role: "B", address: cred.addressB }];
const deploy = NADO_DEPLOYMENTS[ENV];
const pub = createPublicClient({ transport: http(rpc) });
const engine = new EngineClient({ url: engineUrl });

console.log(`mainnet-cohort-status  env=${ENV} chainId=${CHAIN_ID}`);
console.log(`  sequencer=${engineUrl}  rpc=${rpc}`);
console.log(`  deploy keys: ${Object.keys(deploy).join(",")}`);
console.log(`  deploy: ${JSON.stringify(deploy)}`);

// Locate the mainnet USDT0 / quote collateral token address from the deployment (field name unknown
// across SDK versions — try the likely ones; overridable via INK_MAINNET_USDT0).
const USDT0 = process.env.INK_MAINNET_USDT0 || deploy.quoteToken || deploy.usdt0 || deploy.collateral
  || deploy.collateralToken || deploy.quote || deploy.usdc || null;
console.log(`  USDT0 (quote collateral token): ${USDT0 ?? "⚠ not found in deploy — set INK_MAINNET_USDT0"}`);

const asNum = (v) => (v == null ? 0n : typeof v === "object" && v.toFixed ? BigInt(v.toFixed(0)) : BigInt(String(v).split(".")[0] || "0"));
let dec = 6;
if (USDT0 && isAddress(USDT0)) { try { dec = Number(await pub.readContract({ address: USDT0, abi: ERC20, functionName: "decimals" })); } catch { /* keep 6 */ } }

let anyBlocked = false, anyNeedsDeposit = false, anyReady = false;
for (const w of wallets) {
  const addr = w.address;
  const eth = await pub.getBalance({ address: addr }).catch(() => null);
  const usdt = USDT0 && isAddress(USDT0)
    ? await pub.readContract({ address: USDT0, abi: ERC20, functionName: "balanceOf", args: [addr] }).catch(() => null)
    : null;
  const summary = await engine.getSubaccountSummary({ subaccountOwner: addr, subaccountName: SUBACCT }).catch((e) => ({ err: e.message }));
  let collateralX18 = 0n;
  if (summary && Array.isArray(summary.balances)) {
    for (const b of summary.balances) {
      if (Number(b.productId) !== QUOTE_PRODUCT) continue;
      collateralX18 = asNum(b.balance?.amount ?? b.amount ?? b.balanceAmount);
    }
  }
  const hasGas = eth != null && eth > 0n;
  const hasCollateral = collateralX18 > 0n;
  const hasTokens = usdt != null && usdt > 0n;
  const state = hasCollateral ? "READY" : hasTokens ? "NEEDS-DEPOSIT" : "BLOCKED (no collateral, no USDT0)";
  if (state.startsWith("BLOCKED")) anyBlocked = true;
  if (state === "NEEDS-DEPOSIT") anyNeedsDeposit = true;
  if (state === "READY") anyReady = true;
  console.log(`\n  ${w.role ?? "?"} ${addr}`);
  console.log(`    gas ETH      : ${eth == null ? "read-fail" : formatEther(eth)}${hasGas ? "" : "  ⚠ no gas"}`);
  console.log(`    USDT0 token  : ${usdt == null ? (USDT0 ? "read-fail" : "n/a (token addr unknown)") : formatUnits(usdt, dec)}`);
  console.log(`    Nado collat. : ${formatUnits(collateralX18, 18)}  (${typeof summary?.err === "string" ? "summary ERR " + summary.err : "ok"})`);
  console.log(`    => ${state}`);
}

console.log(`\nVERDICT: ${anyBlocked ? "BLOCKED — a wallet has neither Nado collateral nor USDT0; fund it first." : anyNeedsDeposit ? "NEEDS-DEPOSIT — USDT0 present, deposit it into Nado next." : anyReady ? "READY — wallets have Nado collateral." : "unknown"}`);
process.exit(0);
