// Read-only cohort funding check for the A/B self-cross round. NO key, NO unlock, NO writes —
// just reads gas (ETH via RPC), the USDT0 token balance (ERC20), and the Nado collateral
// (getSubaccountSummary quote balance) for BOTH wallets in ~/.nado-ika-testnet/credentials.json.
// Decides, per wallet: ready (has collateral) / needs-deposit (has USDT0, no collateral) /
// blocked (neither). Testnet only.
//
//   node packages/adapter-nado/scripts/cohort-status.mjs
import { EngineClient } from "@nadohq/engine-client";
import { CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS, NADO_DEPLOYMENTS } from "@nadohq/client";
import { createPublicClient, http, formatEther, formatUnits } from "viem";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CHAIN_ID = 763373;
const ENV = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID];
const engineUrl = ENGINE_CLIENT_ENDPOINTS[ENV];
const rpc = process.env.INK_TESTNET_RPC || "https://rpc-gel-sepolia.inkonchain.com";
const USDT0 = process.env.INK_TESTNET_USDT0 || "0x60F50F902b2E91aef7D6c700Eb22599e297fa86F";
const SUBACCT = "default";
const QUOTE_PRODUCT = 0;

const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
];

const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-testnet", "credentials.json"), "utf8"));
const wallets = cred.wallets ?? [{ role: "A", address: cred.address }];
const pub = createPublicClient({ transport: http(rpc) });
const engine = new EngineClient({ url: engineUrl });

const deploy = NADO_DEPLOYMENTS[ENV];
console.log(`cohort-status  env=${ENV} chainId=${CHAIN_ID}`);
console.log(`  sequencer=${engineUrl}  rpc=${rpc}  endpoint=${deploy.endpoint}`);

const asNum = (v) => (v == null ? 0n : typeof v === "object" && v.toFixed ? BigInt(v.toFixed(0)) : BigInt(String(v).split(".")[0] || "0"));

let anyBlocked = false, anyNeedsDeposit = false;
for (const w of wallets) {
  const addr = w.address;
  const eth = await pub.getBalance({ address: addr }).catch(() => null);
  const usdt = await pub.readContract({ address: USDT0, abi: ERC20, functionName: "balanceOf", args: [addr] }).catch(() => null);
  const summary = await engine.getSubaccountSummary({ subaccountOwner: addr, subaccountName: SUBACCT }).catch((e) => ({ err: e.message }));
  let collateralX18 = 0n, balancesSeen = 0;
  if (summary && Array.isArray(summary.balances)) {
    balancesSeen = summary.balances.length;
    for (const b of summary.balances) {
      if (Number(b.productId) !== QUOTE_PRODUCT) continue;
      // the quote (collateral) balance: try the common shapes defensively
      collateralX18 = asNum(b.balance?.amount ?? b.amount ?? b.balanceAmount);
    }
  }
  const ethH = eth == null ? "read-fail" : formatEther(eth);
  const usdtH = usdt == null ? "read-fail" : formatUnits(usdt, 6);
  const collH = formatUnits(collateralX18, 18);
  const hasGas = eth != null && eth > 0n;
  const hasCollateral = collateralX18 > 0n;
  const hasTokens = usdt != null && usdt > 0n;
  const state = hasCollateral ? "READY" : hasTokens ? "NEEDS-DEPOSIT" : "BLOCKED(no collateral, no USDT0)";
  if (state.startsWith("BLOCKED")) anyBlocked = true;
  if (state === "NEEDS-DEPOSIT") anyNeedsDeposit = true;
  console.log(`\n  ${w.role ?? "?"} ${addr}`);
  console.log(`    gas ETH      : ${ethH}${hasGas ? "" : "  ⚠ no gas"}`);
  console.log(`    USDT0 token  : ${usdtH}`);
  console.log(`    Nado collat. : ${collH}  (summary balances: ${typeof summary?.err === "string" ? "ERR " + summary.err : balancesSeen})`);
  console.log(`    => ${state}`);
}

console.log(`\nVERDICT: ${anyBlocked ? "BLOCKED — a wallet has no collateral and no USDT0; STOP (fund it)." : anyNeedsDeposit ? "NEEDS-DEPOSIT — deposit USDT0->collateral before the round." : "READY — both wallets have Nado collateral."}`);
process.exit(anyBlocked ? 2 : 0);
