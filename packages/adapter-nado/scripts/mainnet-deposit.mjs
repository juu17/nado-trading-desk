// Nado Ink-MAINNET deposit — move each wallet's USDT0 into its `default` Nado subaccount.
// ⚠ REAL FUNDS, on-chain writes (approve + depositCollateral). Run ONLY after the operator has
// funded the A/B wallets with USDT0 + a little Ink ETH (gas). Keys are dumped from the encrypted
// custody into THIS PROCESS ONLY to sign — never printed, never logged, never committed.
// Idempotent + capped: deposits min(balance, DEPOSIT_EACH); refuses DEPOSIT_EACH > 200 (the
// project's TIGHT mainnet deposit cap, apps/console/app/lib/chainEnv.ts); skips a wallet that
// already holds Nado collateral or has 0 USDT0 / 0 gas. No minting (mainnet USDT0 is real).
//
//   DEPOSIT_EACH=50 node packages/adapter-nado/scripts/mainnet-deposit.mjs
import "wative-core/node";
import { Workspace } from "wative-core";
import { createWalletClient, createPublicClient, http, defineChain, parseUnits, formatUnits, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NADO_DEPLOYMENTS, CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS, ENDPOINT_ABI, subaccountNameToBytes12 } from "@nadohq/client";
import { EngineClient } from "@nadohq/engine-client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CHAIN_ID = 57073; // Ink mainnet
const RPC = process.env.INK_MAINNET_RPC || "https://rpc-gel.inkonchain.com";
const USDT0 = process.env.INK_MAINNET_USDT0 || "0x0200C29006150606B650577BBE7B6248F58470c1"; // 6-dec, verified
const SUBACCT = "default";
const QUOTE_PRODUCT = 0;
const DEC = 6;
const MAX_DEPOSIT = 200;                                         // project's TIGHT mainnet deposit cap (USDT0)
const DEPOSIT_EACH = Number(process.env.DEPOSIT_EACH || "50");
if (!(DEPOSIT_EACH > 0) || DEPOSIT_EACH > MAX_DEPOSIT) throw new Error(`DEPOSIT_EACH ${DEPOSIT_EACH} out of range (0, ${MAX_DEPOSIT}]`);
const MAX_UINT = (1n << 256n) - 1n;

const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
];

const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-mainnet", "credentials.json"), "utf8"));
const ws = await Workspace.open({ path: cred.workspacePath, password: cred.password });
const acc = ws.accounts[0];
await acc.tryUnlock(cred.password);
const defs = cred.wallets ?? [{ role: "A", index: 0 }, { role: "B", index: 1 }];
const need = Math.max(...defs.map((w) => w.index)) + 1;
while (acc.wallets.length < need) await acc.deriveWallets(need - acc.wallets.length);
const wallets = defs.map((w) => {
  let pk = acc.wallets[w.index].dumpPrivateKey("evm");
  pk = pk.startsWith("0x") ? pk : "0x" + pk;
  return { role: w.role, index: w.index, account: privateKeyToAccount(pk) };
});
await ws.lock(); // keys now only in the viem accounts in process memory — never printed/logged

const chain = defineChain({ id: CHAIN_ID, name: "Ink", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const env = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID];
const deploy = NADO_DEPLOYMENTS[env];
const endpoint = deploy.endpoint;
const engine = new EngineClient({ url: ENGINE_CLIENT_ENDPOINTS[env] });
const subBytes12 = toHex(subaccountNameToBytes12(SUBACCT));
const collOf = async (addr) => {
  const sum = await engine.getSubaccountSummary({ subaccountOwner: addr, subaccountName: SUBACCT }).catch(() => null);
  const q = sum?.balances?.find((b) => Number(b.productId) === QUOTE_PRODUCT);
  return q?.amount ? Number((q.amount.toFixed ? q.amount.toFixed(0) : String(q.amount))) : 0;
};

console.log(`mainnet-deposit  env=${env} chain=${CHAIN_ID}`);
console.log(`  endpoint=${endpoint}  USDT0=${USDT0}  cap=${DEPOSIT_EACH}/wallet (max ${MAX_DEPOSIT})`);

for (const w of wallets) {
  const addr = w.account.address;
  if (await collOf(addr) > 0) { console.log(`  ${w.role} ${addr}: already has Nado collateral — skip`); continue; }
  const bal = await pub.readContract({ address: USDT0, abi: ERC20, functionName: "balanceOf", args: [addr] });
  if (bal === 0n) { console.log(`  ${w.role} ${addr}: 0 USDT0 — nothing to deposit (fund it first)`); continue; }
  const gas = await pub.getBalance({ address: addr });
  if (gas === 0n) { console.log(`  ${w.role} ${addr}: ⚠ 0 gas ETH — cannot send approve/deposit; fund gas first`); continue; }
  const want = parseUnits(String(DEPOSIT_EACH), DEC);
  const amount = bal < want ? bal : want; // deposit min(balance, cap)
  const wc = createWalletClient({ account: w.account, chain, transport: http(RPC) });
  console.log(`  ${w.role} ${addr}: USDT0 ${formatUnits(bal, DEC)} → depositing ${formatUnits(amount, DEC)}`);
  const allowance = await pub.readContract({ address: USDT0, abi: ERC20, functionName: "allowance", args: [addr, endpoint] });
  if (allowance < amount) {
    const ah = await wc.writeContract({ address: USDT0, abi: ERC20, functionName: "approve", args: [endpoint, MAX_UINT] });
    await pub.waitForTransactionReceipt({ hash: ah });
    console.log(`    approve(max): ${ah}`);
  }
  const dh = await wc.writeContract({ address: endpoint, abi: ENDPOINT_ABI, functionName: "depositCollateral", args: [subBytes12, QUOTE_PRODUCT, amount] });
  const r = await pub.waitForTransactionReceipt({ hash: dh });
  console.log(`    depositCollateral: ${r.status} ${dh}`);
}

console.log("confirm (sequencer-indexed collateral):");
for (const w of wallets) {
  let ok = false;
  for (let t = 0; t < 10 && !ok; t++) {
    const amt = await collOf(w.account.address);
    if (amt > 0) { console.log(`  ${w.role} READY (collateral ~${(amt / 1e18).toFixed(2)})`); ok = true; break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!ok) console.log(`  ${w.role} not-ready (no indexed collateral yet)`);
}
console.log("mainnet deposit done.");
process.exit(0);
