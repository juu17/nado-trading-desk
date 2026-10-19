// Nado Ink-testnet PREFLIGHT — read-only. No private key, no funds, no writes.
// Confirms the sequencer + RPC are reachable, prints the deposit contract, and (if
// an address is given) checks its funding. The live write loop is a separate step.
//
//   node scripts/testnet-preflight.mjs
//   INK_TESTNET_ADDRESS=0x… node scripts/testnet-preflight.mjs   # also check funding
//   INK_TESTNET_RPC=https://… node scripts/testnet-preflight.mjs  # override RPC
import { EngineClient } from "@nadohq/engine-client";
import { NADO_DEPLOYMENTS, CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS, ENGINE_WS_CLIENT_ENDPOINTS } from "@nadohq/client";
import { createPublicClient, http, formatEther, isAddress } from "viem";

const CHAIN_ID = 763373; // Ink testnet
const env = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID];
const engineUrl = ENGINE_CLIENT_ENDPOINTS[env];
const wsUrl = ENGINE_WS_CLIENT_ENDPOINTS[env];
const rpc = process.env.INK_TESTNET_RPC || "https://rpc-gel-sepolia.inkonchain.com";
const addr = process.env.INK_TESTNET_ADDRESS;

console.log(`Nado Ink-testnet preflight  (env: ${env}, chainId ${CHAIN_ID})`);
console.log(`  sequencer REST : ${engineUrl}`);
console.log(`  sequencer WS   : ${wsUrl}`);

const ec = new EngineClient({ url: engineUrl });
const status = await ec.getStatus().catch((e) => `ERR ${e.message}`);
console.log(`  sequencer status: ${JSON.stringify(status)}`);
const markets = await ec.getAllMarkets().catch(() => []);
console.log(`  markets available: ${Array.isArray(markets) ? markets.length : "?"}`);

const deploy = NADO_DEPLOYMENTS[env];
console.log(`  endpoint (deposit) contract: ${deploy.endpoint}`);
console.log(`  clearinghouse: ${deploy.clearinghouse}`);

const pub = createPublicClient({ transport: http(rpc) });
const liveChainId = await pub.getChainId().catch((e) => `ERR ${e.message}`);
console.log(`  rpc: ${rpc}  (chainId ${liveChainId})`);
if (liveChainId !== CHAIN_ID) console.log(`  ⚠ RPC chainId ${liveChainId} != ${CHAIN_ID}; set INK_TESTNET_RPC to an Ink-testnet RPC`);

if (addr && isAddress(addr)) {
  const bal = await pub.getBalance({ address: addr }).catch((e) => null);
  console.log(`  account ${addr}: ${bal === null ? "balance read failed" : formatEther(bal) + " ETH (gas)"}`);
  if (bal === 0n) console.log("  ⚠ account has no gas — fund it with Ink-testnet ETH before any on-chain tx");
} else {
  console.log("  (set INK_TESTNET_ADDRESS to a 0x address to check its gas balance)");
}

console.log("\nTo run the live loop the operator must:");
console.log("  1. Fund an Ink-testnet account with testnet ETH (gas) + testnet USDT0 (collateral) from the faucet.");
console.log("  2. Provide the signing key via env (INK_TESTNET_PK) or a wative workspace — never pasted in chat.");
console.log("  3. Then the live deposit -> place/cancel -> read -> withdraw loop runs against this sequencer.");
