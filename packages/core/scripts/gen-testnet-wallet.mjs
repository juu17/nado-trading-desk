// Generate a fresh, disposable Ink-testnet wallet via wative custody. The key lives
// ONLY in an encrypted wative workspace OUTSIDE the repo (~/.nado-ika-testnet); the
// unlock password is written to a 0600 local file there — never printed, never
// committed. Prints ONLY the public address to fund. Idempotent: re-running prints
// the existing address rather than clobbering a funded wallet.
import "wative-core/node";
import { Workspace, newMnemonic } from "wative-core";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = join(homedir(), ".nado-ika-testnet");
const wsPath = join(dir, "workspace");
const credPath = join(dir, "credentials.json");

try {
  const existing = JSON.parse(await readFile(credPath, "utf8"));
  console.log("Existing testnet wallet found (key stays in the encrypted workspace).");
  console.log("ADDRESS TO FUND:", existing.address);
  process.exit(0);
} catch { /* none yet — generate */ }

await mkdir(dir, { recursive: true });
const password = randomBytes(24).toString("base64").replace(/[^A-Za-z0-9]/g, "") + "Aa1!";
const mnemonic = newMnemonic(12);
const ws = await Workspace.open({ path: wsPath, password });
const acc = await ws.accounts.create("testnet", password, mnemonic);
if (acc.wallets.length === 0) await acc.deriveWallets(1);
const evm = acc.wallets[0].evm;
if (!evm) throw new Error("no EVM signer on wallet 0");
const address = evm.publicKey;
await writeFile(credPath, JSON.stringify({ workspacePath: wsPath, password, address }, null, 2), { mode: 0o600 });
await ws.lock();

console.log("Fresh Ink-testnet wallet generated.");
console.log("  key: encrypted wative workspace outside the repo (not committed, not printed)");
console.log("ADDRESS TO FUND:", address);
console.log("\nFund this address, then tell me to run the live loop:");
console.log("  • Ink-testnet ETH (gas) — the Ink Sepolia faucet");
console.log("  • Nado testnet USDT0 (collateral) — the Nado testnet faucet");
