// Nado Ink-testnet LIVE loop runner. Per-phase (argv[2]): status | mint | deposit | trade | withdraw.
// Unlocks the disposable wative workspace (outside the repo), signs with its key.
// Nothing here is committed; the key never leaves memory. Testnet only.
import "wative-core/node";
import { Workspace } from "wative-core";
import { createWalletClient, createPublicClient, http, defineChain, parseUnits, formatUnits, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EngineClient } from "@nadohq/engine-client";
import { NADO_DEPLOYMENTS, CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS, ENDPOINT_ABI, subaccountNameToBytes12, getOrderNonce, getOrderVerifyingAddress, packOrderAppendix } from "@nadohq/client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CHAIN_ID = 763373;
const ENV = CHAIN_ID_TO_CHAIN_ENV[CHAIN_ID];
const deploy = NADO_DEPLOYMENTS[ENV];
const USDT0 = "0x60F50F902b2E91aef7D6c700Eb22599e297fa86F";
const rpc = process.env.INK_TESTNET_RPC || "https://rpc-gel-sepolia.inkonchain.com";
const engineUrl = ENGINE_CLIENT_ENDPOINTS[ENV];
const phase = process.argv[2] || "status";
const SUBACCT = "default";
const QUOTE_PRODUCT = 0;

const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
];

// ---- unlock the disposable wative workspace, export the key into memory ----
const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-testnet", "credentials.json"), "utf8"));
const ws = await Workspace.open({ path: cred.workspacePath, password: cred.password });
const acc = ws.accounts[0];
await acc.tryUnlock(cred.password);
let pk = acc.wallets[0].dumpPrivateKey("evm");
if (!pk.startsWith("0x")) pk = "0x" + pk;
await ws.lock();

const chain = defineChain({ id: CHAIN_ID, name: "Ink Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const account = privateKeyToAccount(pk);
const walletClient = createWalletClient({ account, chain, transport: http(rpc) });
const pub = createPublicClient({ chain, transport: http(rpc) });
const engine = new EngineClient({ url: engineUrl, walletClient });

const addr = account.address;
console.log(`phase=${phase} | wallet=${addr} | env=${ENV} | endpoint=${deploy.endpoint}`);

const usdt = async () => formatUnits(await pub.readContract({ address: USDT0, abi: ERC20, functionName: "balanceOf", args: [addr] }), 6);
const eth = async () => formatUnits(await pub.getBalance({ address: addr }), 18);

async function status() {
  console.log(`  ETH: ${await eth()} | USDT0: ${await usdt()}`);
  const summary = await engine.getSubaccountSummary({ subaccountOwner: addr, subaccountName: SUBACCT }).catch((e) => `ERR ${e.message}`);
  console.log("  subaccount summary:", typeof summary === "string" ? summary : "ok (balances/positions present)");
}

async function mint() {
  const amount = parseUnits(process.env.MINT_USDT0 || "100", 6);
  console.log(`  minting ${formatUnits(amount, 6)} USDT0 -> ${addr} …`);
  const hash = await walletClient.writeContract({ address: USDT0, abi: ERC20, functionName: "mint", args: [addr, amount] });
  console.log("  tx:", hash);
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`  mined: ${r.status} (block ${r.blockNumber}) | USDT0 now: ${await usdt()}`);
}

async function deposit() {
  const amount = parseUnits(process.env.DEPOSIT_USDT0 || "20", 6);
  const current = await pub.readContract({ address: USDT0, abi: ERC20, functionName: "allowance", args: [addr, deploy.endpoint] });
  if (current < amount) {
    console.log(`  approving ${formatUnits(amount, 6)} USDT0 to endpoint …`);
    const ah = await walletClient.writeContract({ address: USDT0, abi: ERC20, functionName: "approve", args: [deploy.endpoint, amount] });
    await pub.waitForTransactionReceipt({ hash: ah });
    console.log("  approved:", ah);
  }
  const rawName = subaccountNameToBytes12(SUBACCT);
  const subBytes12 = typeof rawName === "string" ? rawName : toHex(rawName);
  console.log(`  depositCollateral(${SUBACCT}, product ${QUOTE_PRODUCT}, ${formatUnits(amount, 6)}) …`);
  const dh = await walletClient.writeContract({ address: deploy.endpoint, abi: ENDPOINT_ABI, functionName: "depositCollateral", args: [subBytes12, QUOTE_PRODUCT, amount] });
  console.log("  tx:", dh);
  const r = await pub.waitForTransactionReceipt({ hash: dh });
  console.log(`  mined: ${r.status} (block ${r.blockNumber})`);
  console.log("  (sequencer credits the subaccount after it indexes the deposit — re-run `status` shortly)");
}

async function trade() {
  const pid = Number(process.env.PRODUCT_ID || 2);
  const x18 = (v) => { try { return BigInt(String(v).split(".")[0]); } catch { return 0n; } };
  const mp = await engine.getMarketPrice({ productId: pid }).catch((e) => ({ err: e.message }));
  console.log("  marketPrice raw:", JSON.stringify(mp, (k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 220));
  const bid = x18(mp.bid), ask = x18(mp.ask), mark = x18(mp.markPrice ?? mp.indexPrice ?? mp.price ?? 0);
  const mid = mark > 0n ? mark : (bid > 0n && ask > 0n ? (bid + ask) / 2n : 0n);
  if (mid === 0n) { console.log("  could not determine price; inspect raw above"); return; }
  const market = (await engine.getAllMarkets()).find((m) => m.productId === pid);
  const minSize = BigInt(market.minSize);
  const tick = BigInt(market.priceIncrement || "1") || 1n;
  let priceX18 = (mid * 90n) / 100n;      // 90% of oracle → within the 80–120% band, below bid → rests as maker
  priceX18 = (priceX18 / tick) * tick || tick;
  const nonce = getOrderNonce();
  const expiration = BigInt(Math.floor(Date.now() / 1000) + 3600).toString(); // ~1h
  const appendix = packOrderAppendix({ orderExecutionType: "post_only" }).toString(); // maker, version 1
  const order = { subaccountOwner: addr, subaccountName: SUBACCT, price: priceX18.toString(), amount: minSize.toString(), expiration, appendix };
  console.log(`  place maker BUY product ${pid}: size ${Number(minSize) / 1e18}, price ${Number(priceX18) / 1e18} (mid ${Number(mid) / 1e18})`);
  const orderVerifyingAddr = getOrderVerifyingAddress(pid);
  const res = await engine.placeOrder({ productId: pid, order, nonce, verifyingAddr: orderVerifyingAddr, chainId: CHAIN_ID }).catch((e) => ({ err: e.message, data: e.data }));
  console.log("  placeOrder:", JSON.stringify(res, (k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 320));
  if (res && res.err) return;
  const digest = res.digest ?? res.orderDigest ?? res.data?.digest;
  console.log("  order digest:", digest);
  const open = await engine.getSubaccountOrders({ subaccountOwner: addr, subaccountName: SUBACCT, productId: pid }).catch((e) => ({ err: e.message }));
  console.log("  open orders:", Array.isArray(open?.orders) ? open.orders.length : JSON.stringify(open).slice(0, 160));
  if (digest) {
    const cancel = await engine.cancelOrders({ subaccountOwner: addr, subaccountName: SUBACCT, productIds: [pid], digests: [digest], verifyingAddr: deploy.endpoint, chainId: CHAIN_ID }).catch((e) => ({ err: e.message }));
    console.log("  cancelOrders:", JSON.stringify(cancel, (k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 200));
  }
}

async function withdraw() {
  const amount = (process.env.WITHDRAW_USDT0 || "10");
  const amount6 = parseUnits(amount, 6).toString(); // withdraw amount is in the token's native decimals (6)
  const nonce = await engine.getTxNonce({ subaccountOwner: addr, subaccountName: SUBACCT }).catch(() => undefined);
  console.log(`  withdrawCollateral product ${QUOTE_PRODUCT}, ${amount} USDT0 …`);
  const res = await engine.withdrawCollateral({
    subaccountOwner: addr, subaccountName: SUBACCT, productId: QUOTE_PRODUCT, amount: amount6,
    nonce, verifyingAddr: deploy.endpoint, chainId: CHAIN_ID,
  }).catch((e) => ({ err: e.message }));
  console.log("  withdrawCollateral:", JSON.stringify(res, (k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 240));
}

if (phase === "status") await status();
else if (phase === "mint") await mint();
else if (phase === "deposit") await deposit();
else if (phase === "trade") await trade();
else if (phase === "withdraw") await withdraw();
else console.log("  unknown phase; use: status | mint | deposit | trade | withdraw");
process.exit(0);
