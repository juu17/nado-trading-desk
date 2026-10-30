// Self-fund the fresh taker B2 from A (both in the custody workspace), TINY amounts, for the N=1
// baseline. A already holds testnet USDT0 + gas, so: A transfers a little USDT0 + gas ETH to B2,
// then B2 approves + depositCollateral(USDT0 -> Nado). Hard-gated on NADO_LIVE; keys stay in
// memory, never printed. Touches ONLY A and B2 — never B or the BTC book. Testnet only.
//
//   NADO_LIVE=1 node packages/adapter-nado/scripts/fund-b2.mjs
import "wative-core/node";
import { Workspace } from "wative-core";
import { createWalletClient, createPublicClient, http, defineChain, parseUnits, parseEther, formatUnits, formatEther, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EngineClient } from "@nadohq/engine-client";
import { CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS, NADO_DEPLOYMENTS, ENDPOINT_ABI, subaccountNameToBytes12 } from "@nadohq/client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

if (!(process.env.NADO_LIVE === "1" || process.env.NADO_LIVE === "true")) { console.error("NADO_LIVE unset — refusing to send live txs."); process.exit(2); }
const CHAIN_ID = 763373;
const ENV = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID];
const deploy = NADO_DEPLOYMENTS[ENV];
const engineUrl = ENGINE_CLIENT_ENDPOINTS[ENV];
const rpc = process.env.INK_TESTNET_RPC || "https://rpc-gel-sepolia.inkonchain.com";
const USDT0 = process.env.INK_TESTNET_USDT0 || "0x60F50F902b2E91aef7D6c700Eb22599e297fa86F";
const SUBACCT = "default", QUOTE_PRODUCT = 0;
const SEND_USDT0 = process.env.B2_USDT0 || "2000";    // transfer this many USDT0 A -> B2
const DEPOSIT_USDT0 = process.env.B2_DEPOSIT || "1500"; // deposit this much B2 -> Nado collateral
const SEND_ETH = process.env.B2_ETH || "0.0003";      // tiny gas for B2's 2 txs (L2)

const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
];

const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-testnet", "credentials.json"), "utf8"));
const ws = await Workspace.open({ path: cred.workspacePath, password: cred.password });
const acc = ws.accounts[0]; await acc.tryUnlock(cred.password);
const list = acc.getWalletList();
let pkA = list[0].dumpPrivateKey("evm"); if (!pkA.startsWith("0x")) pkA = "0x" + pkA;
let pkB2 = list[2].dumpPrivateKey("evm"); if (!pkB2.startsWith("0x")) pkB2 = "0x" + pkB2;
await ws.lock();

const chain = defineChain({ id: CHAIN_ID, name: "Ink Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const accA = privateKeyToAccount(pkA), accB2 = privateKeyToAccount(pkB2);
const A = accA.address, B2 = accB2.address;
const wcA = createWalletClient({ account: accA, chain, transport: http(rpc) });
const wcB2 = createWalletClient({ account: accB2, chain, transport: http(rpc) });
const pub = createPublicClient({ chain, transport: http(rpc) });
if (B2.toLowerCase() !== (cred.addressB2 ?? "").toLowerCase()) throw new Error(`index-2 ${B2} != stored B2 ${cred.addressB2}`);
console.log(`fund-b2  A=${A}  B2=${B2}`);

const usdt = (a) => pub.readContract({ address: USDT0, abi: ERC20, functionName: "balanceOf", args: [a] });
const eth = (a) => pub.getBalance({ address: a });
console.log(`before: A eth=${formatEther(await eth(A))} usdt0=${formatUnits(await usdt(A), 6)} | B2 eth=${formatEther(await eth(B2))} usdt0=${formatUnits(await usdt(B2), 6)}`);

// 1) A -> B2 : USDT0
const amt6 = parseUnits(SEND_USDT0, 6);
console.log(`1) A transfers ${SEND_USDT0} USDT0 -> B2 …`);
let h = await wcA.writeContract({ address: USDT0, abi: ERC20, functionName: "transfer", args: [B2, amt6] });
console.log(`   tx ${h} mined=${(await pub.waitForTransactionReceipt({ hash: h })).status}`);
// 2) A -> B2 : gas ETH
console.log(`2) A sends ${SEND_ETH} ETH -> B2 …`);
h = await wcA.sendTransaction({ to: B2, value: parseEther(SEND_ETH) });
console.log(`   tx ${h} mined=${(await pub.waitForTransactionReceipt({ hash: h })).status}`);
// 3) B2 approve USDT0 -> endpoint
const dep6 = parseUnits(DEPOSIT_USDT0, 6);
const cur = await pub.readContract({ address: USDT0, abi: ERC20, functionName: "allowance", args: [B2, deploy.endpoint] });
if (cur < dep6) { console.log(`3) B2 approves ${DEPOSIT_USDT0} USDT0 -> endpoint …`); h = await wcB2.writeContract({ address: USDT0, abi: ERC20, functionName: "approve", args: [deploy.endpoint, dep6] }); console.log(`   tx ${h} mined=${(await pub.waitForTransactionReceipt({ hash: h })).status}`); }
// 4) B2 depositCollateral
const rawName = subaccountNameToBytes12(SUBACCT); const subBytes12 = typeof rawName === "string" ? rawName : toHex(rawName);
console.log(`4) B2 depositCollateral(${SUBACCT}, product ${QUOTE_PRODUCT}, ${DEPOSIT_USDT0}) …`);
h = await wcB2.writeContract({ address: deploy.endpoint, abi: ENDPOINT_ABI, functionName: "depositCollateral", args: [subBytes12, QUOTE_PRODUCT, dep6] });
console.log(`   tx ${h} mined=${(await pub.waitForTransactionReceipt({ hash: h })).status}`);

console.log(`after:  A eth=${formatEther(await eth(A))} usdt0=${formatUnits(await usdt(A), 6)} | B2 eth=${formatEther(await eth(B2))} usdt0=${formatUnits(await usdt(B2), 6)}`);
// confirm Nado collateral credited (may lag a few seconds)
const engine = new EngineClient({ url: engineUrl });
for (let i = 0; i < 10; i++) {
  const sum = await engine.getSubaccountSummary({ subaccountOwner: B2, subaccountName: SUBACCT }).catch(() => ({}));
  const q = (sum.balances ?? []).find((b) => Number(b.productId) === QUOTE_PRODUCT);
  const col = q ? Number((q.amount?.toFixed ? q.amount.toFixed(0) : String(q.amount)).split(".")[0]) / 1e18 : 0;
  if (col > 0) { console.log(`B2 Nado collateral: ${col} USDT0  ✓ funded`); process.exit(0); }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("B2 Nado collateral not yet visible (sequencer may still be indexing the deposit); re-check with cohort-status.");
process.exit(0);
