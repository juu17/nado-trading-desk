// Derive a THIRD Ink-testnet wallet ("B2") — a fresh, FLAT taker for the N=1 baseline, replacing
// B (HD index 1), which is parked holding BTC inventory. B2 is HD wallet index 2 on the SAME
// account, so A (index 0) and B (index 1) are never touched and B2 is deterministic. The key
// stays in the encrypted wative workspace (~/.nado-ika-testnet); only the PUBLIC address is
// printed. Idempotent: if B2 already exists it just reprints its address.
//
//   node packages/core/scripts/gen-testnet-wallet-b2.mjs
import "wative-core/node";
import { Workspace } from "wative-core";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(homedir(), ".nado-ika-testnet");
const credPath = join(dir, "credentials.json");

const cred = JSON.parse(await readFile(credPath, "utf8"));
const ws = await Workspace.open({ path: cred.workspacePath, password: cred.password });
const acc = ws.accounts[0];
if (!acc) throw new Error("no account in workspace — run gen-testnet-wallet.mjs first");
await acc.tryUnlock(cred.password);

// Ensure at least 3 wallets (A=0, B=1, B2=2). deriveWallets(count) derives `count` MORE.
let list = acc.getWalletList();
if (list.length < 3) { await acc.deriveWallets(3 - list.length); list = acc.getWalletList(); }

const evmA = list[0]?.evm, evmB = list[1]?.evm, evmB2 = list[2]?.evm;
if (!evmA || !evmB || !evmB2) throw new Error("expected EVM signers on wallets 0, 1 and 2");
const addressA = evmA.publicKey, addressB = evmB.publicKey, addressB2 = evmB2.publicKey;
await ws.lock();

// Sanity: derived index 0/1 must equal the stored A/B, or the mapping drifted.
if (cred.address && cred.address.toLowerCase() !== addressA.toLowerCase()) throw new Error(`derived wallet 0 (${addressA}) != stored A`);
if (cred.addressB && cred.addressB.toLowerCase() !== addressB.toLowerCase()) throw new Error(`derived wallet 1 (${addressB}) != stored B`);

// Record B2 as the ACTIVE taker; keep A (index 0) and B (index 1, parked) intact.
const next = {
  ...cred,
  address: cred.address || addressA,
  addressB,
  addressB2,
  activeTaker: "B2",
  wallets: [
    { role: "A", index: 0, address: addressA },
    { role: "B", index: 1, address: addressB, parked: true },
    { role: "B2", index: 2, address: addressB2 },
  ],
};
await writeFile(credPath, JSON.stringify(next, null, 2), { mode: 0o600 });

console.log("Fresh taker wallet B2 ready (key stays in the encrypted workspace, never printed).");
console.log("  A  (index 0, maker):", addressA);
console.log("  B2 (index 2, taker):", addressB2);
console.log("  (B index 1 is parked, out of the cohort)");
console.log("\nFund B2 on Ink testnet, then tell me to run the N=1 baseline:");
console.log("  • Ink-testnet ETH (gas) — the Ink Sepolia faucet");
console.log("  • Nado testnet USDT0 (collateral) — the Nado testnet faucet");
