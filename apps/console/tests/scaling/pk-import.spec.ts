// =============================================================================
// PK-import custody flow: pasting raw EVM private keys creates a PK cohort (wative's second
// account kind) — one wallet per key, at the key's real address, with NO HD derivation. Then
// a PK wallet signs a real Nado order in-tab and recovers to itself, proving the live signing
// path is unchanged for PK wallets. Uses the canonical PUBLIC Hardhat/Anvil test keys (no real
// funds anywhere). Real in-tab wative crypto; the sequencer/RPC are mocked for determinism.
// =============================================================================
import { test, expect } from "@playwright/test";
import { mockState, mockRelay, mockInkRpc, MockSequencer, passGate } from "../_helpers/mock-live";

const ONE_ETH = 1_000_000_000_000_000_000n;
// Canonical Hardhat/Anvil accounts #0 and #1 — PUBLIC test keys, unfunded on any real chain.
const KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDR0 = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const KEY1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ADDR1 = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const trunc = (a: string) => `${a.slice(0, 10)}…${a.slice(-6)}`; // the custody list format

test("pk-import-flow: raw private keys create a PK cohort at the correct addresses, and a PK wallet signs", async ({ page }) => {
  const seq = new MockSequencer();
  await seq.install(page);
  await mockState(page);
  await mockRelay(page);
  await mockInkRpc(page, { defaultWei: ONE_ETH });

  await page.goto("/");
  await passGate(page, "test-pw-123"); // clear the entry gate (onboard the vault) before the PK import
  await page.getByPlaceholder("workspace password").fill("test-pw-123");
  await page.getByPlaceholder(/paste private keys/i).fill(`${KEY0}\n${KEY1}`);
  await page.getByRole("button", { name: /^Import private keys$/ }).click();

  // Unlocked, with exactly one live wallet per key AT THE KEY'S REAL ADDRESS (so it's a PK
  // import — the keys map to their own addresses — not an HD derivation from a mnemonic).
  await page.getByText(/In-browser custody · unlocked/i).waitFor({ timeout: 30_000 });
  const aside = page.locator("aside").first();
  await expect(aside.getByText(/imported keys: 2 wallet\(s\)/i)).toBeVisible();
  await expect(aside.getByText(new RegExp(trunc(ADDR0), "i"))).toBeVisible();
  await expect(aside.getByText(new RegExp(trunc(ADDR1), "i"))).toBeVisible();

  // A PK wallet signs a real Nado order in-tab and recovers to itself — the live signing path
  // is identical for PK and HD wallets (both expose the same .evm signer).
  await aside.getByRole("button", { name: /Verify in-tab signing/i }).click();
  await expect(aside.getByText(/in-tab sign \+ recover OK/i)).toBeVisible({ timeout: 15_000 });
});
