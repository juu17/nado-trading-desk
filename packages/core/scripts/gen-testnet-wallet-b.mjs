// Derive the SECOND Ink-testnet wallet ("B") for the A<->B self-cross cohort, in the
// SAME encrypted wative workspace that already holds wallet A (index 0). B is HD wallet
// index 1 on the same account, so A is never touched and B is deterministic across runs.
// The key stays in the encrypted workspace (~/.nado-ika-testnet); only the PUBLIC address
// is printed. Idempotent: if B already exists it just reprints B's address.
//
//   node packages/core/scripts/gen-testnet-wallet-b.mjs
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

// Ensure at least 2 wallets exist (A=index 0, B=index 1). deriveWallets(count) derives
// `count` MORE (returns {before, after}); only derive the shortfall — never clobber A.
let list = acc.getWalletList();
if (list.length < 2) {
  await acc.deriveWallets(2 - list.length);
  list = acc.getWalletList();
}

const evmA = list[0]?.evm;
const evmB = list[1]?.evm;
if (!evmA || !evmB) throw new Error("expected EVM signers on wallets 0 and 1");
const addressA = evmA.publicKey;
const addressB = evmB.publicKey;
await ws.lock();

// Sanity: the derived index-0 address MUST equal the stored A, or the workspace/cred
// mapping drifted and B could be wrong.
if (cred.address && cred.address.toLowerCase() !== addressA.toLowerCase()) {
  throw new Error(`derived wallet 0 (${addressA}) != stored A (${cred.address}); refusing to record B`);
}

// Record B without disturbing the existing `address` (A), which other scripts read.
const next = {
  ...cred,
  address: cred.address || addressA,
  addressB,
  wallets: [
    { role: "A", index: 0, address: addressA },
    { role: "B", index: 1, address: addressB },
  ],
};
await writeFile(credPath, JSON.stringify(next, null, 2), { mode: 0o600 });

console.log("Cohort wallet B ready (key stays in the encrypted workspace, never printed).");
console.log("  A (index 0):", addressA);
console.log("  B (index 1):", addressB);
console.log("\nFund BOTH A and B on Ink testnet, then tell me to run the live low-N round:");
console.log("  • Ink-testnet ETH (gas) — the Ink Sepolia faucet");
console.log("  • Nado testnet USDT0 (collateral) — the Nado testnet faucet");
