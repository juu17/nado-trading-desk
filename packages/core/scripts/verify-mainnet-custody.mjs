// Read-only safety check: prove the ~/.nado-ika-mainnet custody re-opens, unlocks, and derives the
// SAME two addresses recorded in credentials.json — i.e. the harness can actually SIGN for the
// wallets the operator is about to fund. No network, no funds, no writes. Run before funding.
//
//   node packages/core/scripts/verify-mainnet-custody.mjs
import "wative-core/node";
import { Workspace } from "wative-core";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const cred = JSON.parse(await readFile(join(homedir(), ".nado-ika-mainnet", "credentials.json"), "utf8"));
const ws = await Workspace.open({ path: cred.workspacePath, password: cred.password });
const acc = ws.accounts[0];
if (!acc) throw new Error("no cohort in workspace");
await acc.tryUnlock(cred.password);
const list = acc.getWalletList();
const a = list[0]?.evm?.publicKey, b = list[1]?.evm?.publicKey;
await ws.lock();

const okA = !!a && a.toLowerCase() === String(cred.address).toLowerCase();
const okB = !!b && b.toLowerCase() === String(cred.addressB).toLowerCase();
console.log(`chainId: ${cred.chainId}`);
console.log(`signer A (index 0): ${a}  ${okA ? "✓ matches credentials" : "✗ MISMATCH"}`);
console.log(`signer B (index 1): ${b}  ${okB ? "✓ matches credentials" : "✗ MISMATCH"}`);
console.log(okA && okB
  ? "\n✓ custody loads and signs for BOTH funding addresses — safe to fund."
  : "\n🚨 MISMATCH — do NOT fund; regenerate the custody.");
process.exit(okA && okB ? 0 : 1);
