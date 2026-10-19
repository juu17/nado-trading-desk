// Nado Ink-testnet COHORT funding harness (Option A — separate EOA wallets).
// Derives N disposable EOAs under the one disposable wative workspace, then uses
// wallet 0 (the already-funded EOA) as a TREASURY to: fan out a little gas ETH to
// 1..N-1, mint USDT0 to each, and have each wallet approve + depositCollateral into
// its own `default` subaccount. Ink gas is ~1e-7 ETH/tx so the fan-out is cheap.
//
// Keys live only in the encrypted workspace / this process memory — never printed,
// never committed. Idempotent: skips wallets already gassed / minted / deposited.
//   COHORT_N=3 GAS_EACH=0.00003 MINT_EACH=100 DEPOSIT_EACH=50 node scripts/fund-cohort.mjs
import "wative-core/node";
import { Workspace } from "wative-core";
import { createWalletClient, createPublicClient, http, defineChain, parseUnits, formatUnits, parseEther, formatEther, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NADO_DEPLOYMENTS, CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS, ENDPOINT_ABI, subaccountNameToBytes12 } from "@nadohq/client";
import { EngineClient } from "@nadohq/engine-client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CHAIN_ID = 763373;
const RPC = process.env.INK_TESTNET_RPC || "https://rpc-gel-sepolia.inkonchain.com";
const USDT0 = "0x60F50F902b2E91aef7D6c700Eb22599e297fa86F";
const SUBACCT = "default";
const QUOTE_PRODUCT = 0;
const N = Number(process.env.COHORT_N || 3);
const GAS_EACH = process.env.GAS_EACH || "0.00003";
const MINT_EACH = process.env.MINT_EACH || "100";
const DEPOSIT_EACH = process.env.DEPOSIT_EACH || "50";
const MAX_UINT = (1n << 256n) - 1n;

const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
];

const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-testnet", "credentials.json"), "utf8"));
const ws = await Workspace.open({ path: cred.workspacePath, password: cred.password });
const acc = ws.accounts[0];
await acc.tryUnlock(cred.password);
while (acc.wallets.length < N) await acc.deriveWallets(N - acc.wallets.length); // HD-derive the cohort
const pks = acc.wallets.slice(0, N).map((w) => { let p = w.dumpPrivateKey("evm"); return (p.startsWith("0x") ? p : "0x" + p); });
await ws.lock();

const chain = defineChain({ id: CHAIN_ID, name: "Ink Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const accounts = pks.map((pk) => privateKeyToAccount(pk));
const addrs = accounts.map((a) => a.address);
const pub = createPublicClient({ chain, transport: http(RPC) });
const wc = (i) => createWalletClient({ account: accounts[i], chain, transport: http(RPC) });
const env = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID];
const deploy = NADO_DEPLOYMENTS[env];
const engine = new EngineClient({ url: ENGINE_CLIENT_ENDPOINTS[env] });
const endpoint = deploy.endpoint;

console.log(`cohort N=${N} on ${env} (chain ${CHAIN_ID})`);
addrs.forEach((a, i) => console.log(`  live:${i}  ${a}${i === 0 ? "  (treasury / already funded)" : ""}`));

const treasury = wc(0);
const gasEach = parseEther(GAS_EACH);
const mintEach = parseUnits(MINT_EACH, 6);
const depEach = parseUnits(DEPOSIT_EACH, 6);

// 1) gas fan-out: treasury -> 1..N-1 (serialized on the treasury nonce)
for (let i = 1; i < N; i++) {
  const bal = await pub.getBalance({ address: addrs[i] });
  if (bal >= gasEach / 2n) { console.log(`  gas live:${i} ok (${formatEther(bal)} ETH)`); continue; }
  const h = await treasury.sendTransaction({ to: addrs[i], value: gasEach });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  gas -> live:${i}: ${formatEther(gasEach)} ETH (${h})`);
}
// 2) mint USDT0: treasury mints to 1..N-1 (serialized)
for (let i = 1; i < N; i++) {
  const bal = await pub.readContract({ address: USDT0, abi: ERC20, functionName: "balanceOf", args: [addrs[i]] });
  if (bal >= depEach) { console.log(`  usdt0 live:${i} ok (${formatUnits(bal, 6)})`); continue; }
  const h = await treasury.writeContract({ address: USDT0, abi: ERC20, functionName: "mint", args: [addrs[i], mintEach] });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  mint ${MINT_EACH} USDT0 -> live:${i} (${h})`);
}
// 3) each wallet 1..N-1 approves (max) + depositCollateral into its own default subaccount
const subBytes12 = toHex(subaccountNameToBytes12(SUBACCT));
for (let i = 1; i < N; i++) {
  const allowance = await pub.readContract({ address: USDT0, abi: ERC20, functionName: "allowance", args: [addrs[i], endpoint] });
  if (allowance < depEach) {
    const ah = await wc(i).writeContract({ address: USDT0, abi: ERC20, functionName: "approve", args: [endpoint, MAX_UINT] });
    await pub.waitForTransactionReceipt({ hash: ah });
    console.log(`  approve(max) live:${i} (${ah})`);
  }
  const dh = await wc(i).writeContract({ address: endpoint, abi: ENDPOINT_ABI, functionName: "depositCollateral", args: [subBytes12, QUOTE_PRODUCT, depEach] });
  const r = await pub.waitForTransactionReceipt({ hash: dh });
  console.log(`  deposit ${DEPOSIT_EACH} USDT0 live:${i}: ${r.status} (${dh})`);
}
// 4) preflight: poll each lane's sequencer-INDEXED collateral (on-chain confirmed != credited)
console.log("preflight (indexed collateral):");
for (let i = 0; i < N; i++) {
  let ok = false;
  for (let t = 0; t < 10 && !ok; t++) {
    const sum = await engine.getSubaccountSummary({ subaccountOwner: addrs[i], subaccountName: SUBACCT }).catch(() => null);
    const q = sum?.balances?.find((b) => Number(b.productId) === QUOTE_PRODUCT);
    const amt = q?.amount ? Number((q.amount.toFixed ? q.amount.toFixed(0) : String(q.amount))) : 0;
    if (amt > 0) { console.log(`  live:${i} READY (collateral ~${(amt / 1e18).toFixed(2)})`); ok = true; break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!ok) console.log(`  live:${i} NOT-ready (no indexed collateral yet)`);
}
console.log("cohort funding done.");
process.exit(0);
