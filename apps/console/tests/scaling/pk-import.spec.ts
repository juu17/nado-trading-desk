// =============================================================================
// PK-import custody flow: pasting raw EVM private keys creates a PK cohort (wative's second
// account kind) — one wallet per key, at the key's real address, with NO HD derivation. The PK
// custody path now lives on the Accounts page (the legacy in-sidebar custody panel is gone), so
// this drives the /accounts "PK (import keys)" form and verifies the imported wallets land on the
// home fleet AT THE KEYS' REAL ADDRESSES. Uses the canonical PUBLIC Hardhat/Anvil test keys (no
// real funds anywhere). Real in-tab wative crypto; the sequencer/RPC are mocked for determinism.
// (In-tab SIGNING parity for PK wallets is structural — PK and HD wallets expose the same .evm
// signer — and is exercised end-to-end by withdraw-flow, so it is not re-asserted here.)
// =============================================================================
import { test, expect } from "@playwright/test";
import { mockState, mockRelay, mockInkRpc, MockSequencer, passGate } from "../_helpers/mock-live";

const ONE_ETH = 1_000_000_000_000_000_000n;
// Canonical Hardhat/Anvil accounts #0 and #1 — PUBLIC test keys, unfunded on any real chain.
const KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDR0 = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const KEY1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ADDR1 = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const short = (v: string) => `${v.slice(0, 6)}…${v.slice(-4)}`; // the home wallet-card address format

test("pk-import-flow: raw private keys create a PK cohort at the correct addresses, one wallet per key", async ({ page }) => {
  const seq = new MockSequencer();
  await seq.install(page);
  await mockState(page);
  await mockRelay(page);
  await mockInkRpc(page, { defaultWei: ONE_ETH });

  await page.goto("/");
  await passGate(page, "test-pw-123"); // clear the entry gate (onboard the vault) before the PK import

  // Import the two public test keys as a PK account on the Accounts page.
  await page.getByRole("link", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "PK (import keys)" }).click();
  await page.getByPlaceholder("e.g. market-makers").fill("pk-cohort");
  await page.getByPlaceholder("vault password").fill("test-pw-123");
  await page.getByPlaceholder(/private key per line/i).fill(`${KEY0}\n${KEY1}`);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("account-block").filter({ hasText: "pk-cohort" })).toBeVisible({ timeout: 30_000 });

  // Back on the home fleet: exactly one wallet per key, each AT THE KEY'S REAL ADDRESS (a PK import —
  // the keys map to their own addresses — not an HD derivation from a mnemonic).
  await page.getByRole("link", { name: "Wallets", exact: true }).click();
  await expect(page.getByTestId("wallet-card")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("wallet-card").filter({ hasText: short(ADDR0) })).toBeVisible();
  await expect(page.getByTestId("wallet-card").filter({ hasText: short(ADDR1) })).toBeVisible();
});
