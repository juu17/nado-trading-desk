// =============================================================================
// Sidebar account filter (the multi-checkbox dropdown): one always-visible checkbox per account,
// toggling one hides/shows exactly that account's wallet cards, None/All clear/restore, Escape
// closes. Guards the regression where the Kumo DropdownMenu port drew no box for unchecked rows
// and nothing covered the filter at all.
// Real in-tab wative crypto + IndexedDB; the sequencer/RPC are mocked for determinism.
// =============================================================================
import { test, expect } from "@playwright/test";
import { mockState, mockRelay, mockNativeRpc, MockSequencer, passGate } from "../_helpers/mock-live";

// Canonical Hardhat/Anvil account #0 — a PUBLIC test key, unfunded on any real chain.
const KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

test("account-filter-flow: checkboxes filter wallet cards per account; None/All; Escape closes", async ({ page }) => {
  await new MockSequencer().install(page);
  await mockState(page);
  await mockRelay(page);
  await mockNativeRpc(page);

  await page.goto("/");
  await passGate(page);

  // Two accounts: HD "alpha" (2 wallets) + PK "beta" (1 wallet).
  await page.getByRole("link", { name: "Accounts" }).click();
  await page.getByPlaceholder("e.g. market-makers").fill("alpha");
  await page.getByPlaceholder("vault password").fill("test-pw-123");
  await page.getByLabel("Wallets to derive").fill("2");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("account-block").filter({ hasText: "alpha" })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "PK (import keys)" }).click();
  await page.getByPlaceholder("e.g. market-makers").fill("beta");
  await page.getByPlaceholder("vault password").fill("test-pw-123");
  await page.getByPlaceholder("0x… — one private key per line").fill(KEY0);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("account-block").filter({ hasText: "beta" })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("link", { name: "Wallets", exact: true }).click();
  const cards = page.getByTestId("wallet-card");
  await expect(cards).toHaveCount(3, { timeout: 30_000 });

  // Open the filter: one checkbox per account, all checked.
  const trigger = page.getByRole("button", { name: "All accounts" });
  await trigger.click();
  const filter = page.getByRole("dialog");
  const alpha = filter.getByRole("checkbox", { name: "alpha" });
  const beta = filter.getByRole("checkbox", { name: "beta" });
  await expect(alpha).toBeChecked();
  await expect(beta).toBeChecked();

  // Uncheck beta → only alpha's 2 cards remain; the popover stays open; the unchecked box stays visible.
  await beta.click();
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: "beta" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "1 of 2 accounts" })).toBeVisible();
  await expect(beta).toBeVisible();
  await expect(beta).not.toBeChecked();

  // None → no cards; All → all three back.
  await filter.getByRole("button", { name: "None", exact: true }).click();
  await expect(cards).toHaveCount(0);
  await expect(alpha).not.toBeChecked();
  await expect(page.getByRole("button", { name: "No accounts" })).toBeVisible();
  await filter.getByRole("button", { name: "All", exact: true }).click();
  await expect(cards).toHaveCount(3);
  await expect(alpha).toBeChecked();
  await expect(beta).toBeChecked();

  // Escape closes the popover.
  await page.keyboard.press("Escape");
  await expect(filter).toHaveCount(0);
});
