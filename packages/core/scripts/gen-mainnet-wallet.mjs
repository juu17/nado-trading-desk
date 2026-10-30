// Generate a fresh, disposable Ink-MAINNET custody via wative — TWO wallets (A maker, B taker)
// for the gated minimal capacity probe. Keys live ONLY in an encrypted wative workspace OUTSIDE
// the repo (~/.nado-ika-mainnet); the unlock password is written to a 0600 local file there —
// never printed, never committed. Prints ONLY the two public addresses to fund. Idempotent:
// re-running prints the existing addresses rather than clobbering funded wallets.
//
// ⚠ REAL FUNDS. Fund ONLY the ~$100 minimal-probe amount. Mirror of gen-testnet-wallet.mjs.
//
//   node packages/core/scripts/gen-mainnet-wallet.mjs
import "wative-core/node";
import { Workspace, newMnemonic } from "wative-core";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = join(homedir(), ".nado-ika-mainnet");
const wsPath = join(dir, "workspace");
const credPath = join(dir, "credentials.json");
const CHAIN_ID = 57073; // Ink mainnet

try {
  const existing = JSON.parse(await readFile(credPath, "utf8"));
  console.log("Existing MAINNET custody found (keys stay in the encrypted workspace, never printed).");
  console.log("  A (index 0, maker):", existing.address);
  console.log("  B (index 1, taker):", existing.addressB);
  process.exit(0);
} catch { /* none yet — generate */ }

await mkdir(dir, { recursive: true });
const password = randomBytes(24).toString("base64").replace(/[^A-Za-z0-9]/g, "") + "Aa1!";
const mnemonic = newMnemonic(12);
const ws = await Workspace.open({ path: wsPath, password });
const acc = await ws.accounts.create("mainnet", password, mnemonic);
const have = acc.wallets.length;
if (have < 2) await acc.deriveWallets(2 - have);
const evmA = acc.wallets[0]?.evm, evmB = acc.wallets[1]?.evm;
if (!evmA || !evmB) throw new Error("expected EVM signers on wallets 0 and 1");
const addressA = evmA.publicKey, addressB = evmB.publicKey;
await writeFile(credPath, JSON.stringify({
  workspacePath: wsPath, password, chainId: CHAIN_ID,
  address: addressA, addressB, activeTaker: "B",
  wallets: [
    { role: "A", index: 0, address: addressA },
    { role: "B", index: 1, address: addressB },
  ],
}, null, 2), { mode: 0o600 });
await ws.lock();

console.log("Fresh Ink-MAINNET custody generated.");
console.log("  keys: encrypted wative workspace outside the repo (not committed, not printed)");
console.log("  A (index 0, maker):", addressA);
console.log("  B (index 1, taker):", addressB);
console.log("\nFund BOTH on Ink MAINNET (chainId 57073) — the ~$100 minimal probe ONLY:");
console.log("  • a little Ink ETH to each (gas)");
console.log("  • ~$50 USDT0 collateral to each (≈$100 total), then deposit it into Nado");
console.log("Then tell me to proceed to GATE 2 (the 3-round canary).");
