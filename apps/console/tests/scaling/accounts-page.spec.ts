// =============================================================================
// Accounts page (/accounts): the dedicated account-management surface — blocks + a SINGLE
// create/import form (no wizard). Proves creating an HD account (fresh mnemonic + derive N),
// deriving more, importing a PK account from a raw key, renaming, and dropping — all in-tab
// (real wative-core crypto + IndexedDB), reached through the app entry gate via client-nav.
// Sequencer/RPC are mocked so the home page we pass through stays offline + deterministic.
// =============================================================================
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { mockState, mockRelay, mockNativeRpc, passGate } from "../_helpers/mock-live";

// Canonical Hardhat/Anvil account #0 — a PUBLIC test key, unfunded on any real chain.
const KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDR0 = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // KEY0's address

test("accounts-page-flow: create/derive HD + import PK, rename, and drop — all in-tab", async ({ page }) => {
  await mockState(page);
  await mockRelay(page);
  await mockNativeRpc(page);

  await page.goto("/");
  await passGate(page); // onboard an empty vault on entry
  // Client-nav to /accounts (keeps the in-memory session; a full load would re-lock the vault).
  await page.getByRole("link", { name: "Accounts" }).click();
  await expect(page.getByText(/No accounts yet/i)).toBeVisible();

  // --- create an HD account with 2 derived wallets (fresh in-tab mnemonic) ---
  await page.getByPlaceholder("e.g. market-makers").fill("makers");
  await page.getByPlaceholder("vault password").fill("test-pw-123");
  await page.getByLabel("Wallets to derive").fill("2");
  await page.getByRole("button", { name: "Create account" }).click();

  const makers = page.getByTestId("account-block").filter({ hasText: "makers" });
  await expect(makers).toBeVisible({ timeout: 30_000 });
  await expect(makers.getByText("HD", { exact: true })).toBeVisible();
  await expect(makers.getByText(/2 wallet\(s\)/)).toBeVisible();

  // --- derive one more → 3 wallets (the block's derive count defaults to 1) ---
  await makers.getByRole("button", { name: "Derive more wallets" }).click();
  await expect(makers.getByText(/3 wallet\(s\)/)).toBeVisible({ timeout: 15_000 });

  // --- Export addresses: downloads a .txt of ONLY this account's 3 addresses, one per line, no index ---
  {
    const [dl] = await Promise.all([
      page.waitForEvent("download"),
      makers.getByRole("button", { name: "Export addresses" }).click(),
    ]);
    expect(dl.suggestedFilename()).toBe("makers-addresses.txt");
    const lines = readFileSync((await dl.path())!, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toMatch(/^0x[0-9a-fA-F]{40}$/); // address only, no index/prefix
  }

  // --- import a PK account from a raw key → exactly 1 wallet (no HD derivation) ---
  await page.getByRole("button", { name: "PK (import keys)" }).click();
  // The camera QR-scan control sits by the private-key field (import without the clipboard).
  await expect(page.getByRole("button", { name: /Scan QR/i })).toBeVisible();
  await page.getByPlaceholder("e.g. market-makers").fill("imported");
  await page.getByPlaceholder("vault password").fill("test-pw-123");
  await page.getByPlaceholder("0x… — one private key per line").fill(KEY0);
  await page.getByRole("button", { name: "Create account" }).click();

  const imported = page.getByTestId("account-block").filter({ hasText: "imported" });
  await expect(imported).toBeVisible({ timeout: 30_000 });
  await expect(imported.getByText("PK", { exact: true })).toBeVisible();
  await expect(imported.getByText(/1 wallet\(s\)/)).toBeVisible();

  // --- the PK account exports exactly the imported key's address (one line) ---
  {
    const [dl] = await Promise.all([
      page.waitForEvent("download"),
      imported.getByRole("button", { name: "Export addresses" }).click(),
    ]);
    const lines = readFileSync((await dl.path())!, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.toLowerCase()).toBe(ADDR0);
  }

  // --- rename "imported" → "pk-funded" (2nd block; while editing, its name becomes an input, so
  //     a hasText filter would no longer match it — address it positionally) ---
  const importedBlock = page.getByTestId("account-block").nth(1);
  await importedBlock.getByRole("button", { name: "Rename" }).click();
  await importedBlock.getByRole("textbox").fill("pk-funded"); // the only textbox in the block while renaming
  await importedBlock.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("account-block").filter({ hasText: "pk-funded" })).toBeVisible();

  // --- drop "makers" (two-click confirm); the PK account survives ---
  await makers.getByRole("button", { name: "Drop" }).click();
  await makers.getByRole("button", { name: "Confirm drop" }).click();
  await expect(page.getByTestId("account-block").filter({ hasText: "makers" })).toHaveCount(0);
  await expect(page.getByTestId("account-block").filter({ hasText: "pk-funded" })).toBeVisible();
});
