// =============================================================================
// Gated vault-lifecycle e2e — the two paths the incremental step 3–5 specs don't cover:
//  (1) UNLOCK-after-reload: a persisted vault LOCKS on a fresh document load (the in-memory session
//      is gone) and its wallets return after unlocking via the gate — proving IndexedDB persistence,
//      the gate's "locked → unlock" branch, and unlockVault repopulating the cohort.
//  (2) full ONBOARD → create an account on /accounts → home shows that REAL account's wallets.
// Real in-tab wative crypto + IndexedDB; the sequencer/RPC are mocked for determinism.
// =============================================================================
import { test, expect } from "@playwright/test";
import { mockState, mockRelay, mockNativeRpc, MockSequencer, unlockGeneratedCohort, passGate } from "../_helpers/mock-live";

const COHORT_N = 3; // the home "Generate N in-tab" default

test("gate-unlock-flow: a reload locks the vault; unlocking returns the persisted wallets", async ({ page }) => {
  await new MockSequencer().install(page);
  await mockState(page);
  await mockRelay(page);
  await mockNativeRpc(page);

  await page.goto("/");
  await unlockGeneratedCohort(page); // onboard + generate a 3-wallet in-tab cohort
  await expect(page.getByTestId("wallet-card")).toHaveCount(COHORT_N, { timeout: 30_000 });

  // A full reload drops the in-memory session; the persisted vault (IndexedDB) is now LOCKED,
  // so the gate shows its unlock variant and the wallets are hidden.
  await page.reload();
  await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create vault" })).toHaveCount(0); // not onboarding
  await expect(page.getByTestId("wallet-card")).toHaveCount(0);

  // Unlock with the vault password → the SAME cohort loads back from IndexedDB.
  await page.getByPlaceholder("vault password", { exact: true }).fill("test-pw-123");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("wallet-card")).toHaveCount(COHORT_N, { timeout: 30_000 });
});

test("gate-reset-flow: the Unlock screen's Danger-zone reset wipes the vault back to onboarding", async ({ page }) => {
  await new MockSequencer().install(page);
  await mockState(page);
  await mockRelay(page);
  await mockNativeRpc(page);

  await page.goto("/");
  await unlockGeneratedCohort(page); // onboard + a cohort so a real vault persists
  await expect(page.getByTestId("wallet-card")).toHaveCount(COHORT_N, { timeout: 30_000 });

  await page.reload(); // in-memory session gone → the persisted vault shows the Unlock gate
  await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible();

  // Danger zone: reset is a two-click confirm → the vault is erased and the gate returns to onboarding
  // (the escape hatch for a lost password, which has no recovery).
  await page.getByRole("button", { name: "Reset vault" }).click();
  await page.getByRole("button", { name: "Erase & start over" }).click();
  await expect(page.getByPlaceholder("confirm vault password")).toBeVisible({ timeout: 30_000 }); // onboarding only
  await expect(page.getByRole("button", { name: "Create vault" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Unlock" })).toHaveCount(0); // no vault left to unlock
});

test("gated-onboard-flow: onboard → create an account on /accounts → home shows its wallets", async ({ page }) => {
  await new MockSequencer().install(page);
  await mockState(page);
  await mockRelay(page);
  await mockNativeRpc(page);

  await page.goto("/");
  await passGate(page); // onboard an EMPTY vault
  // Empty vault → the home shows the create-account prompt and no wallet cards.
  await expect(page.getByTestId("wallet-card")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Create an account/i })).toBeVisible();

  // Create an HD account with 2 wallets on /accounts.
  await page.getByRole("link", { name: "Accounts" }).click();
  await page.getByPlaceholder("e.g. market-makers").fill("desk-a");
  await page.getByPlaceholder("vault password").fill("test-pw-123");
  await page.getByLabel("Wallets to derive").fill("2");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("account-block").filter({ hasText: "desk-a" })).toBeVisible({ timeout: 30_000 });

  // Back to home → it shows the 2 wallets, each grouped under the REAL account name "desk-a".
  // Kumo Breadcrumbs link "Wallets" (the old "←" text glyph is now a Phosphor icon, no accessible name).
  await page.getByRole("link", { name: "Wallets", exact: true }).click();
  await expect(page.getByTestId("wallet-card")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("wallet-card").filter({ hasText: "desk-a" })).toHaveCount(2);
});

test("network-switch-flow: the 2-pole segment control flips testnet↔mainnet (mainnet behind a confirm)", async ({ page }) => {
  await new MockSequencer().install(page);
  await mockState(page);
  await mockRelay(page);
  await mockNativeRpc(page);

  await page.goto("/");
  await passGate(page); // onboard an empty vault so the app (sidebar) renders

  // Default = testnet: the segment shows Testnet active.
  const seg = page.getByRole("group", { name: "Network" });
  await expect(seg.getByRole("button", { name: "testnet" })).toHaveAttribute("aria-pressed", "true");

  // Tap Mainnet → a confirm appears first (real funds); Cancel keeps testnet.
  await seg.getByRole("button", { name: "mainnet" }).click();
  await expect(page.getByText(/Switch to MAINNET\?/i)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(seg.getByRole("button", { name: "testnet" })).toHaveAttribute("aria-pressed", "true");

  // Tap Mainnet → confirm → the segment flips to Mainnet (no rebuild, live), and it propagates
  // app-wide (the sidebar workspace label reads mainnet).
  await seg.getByRole("button", { name: "mainnet" }).click();
  await page.getByRole("button", { name: "Switch to Mainnet" }).click();
  await expect(seg.getByRole("button", { name: "mainnet" })).toHaveAttribute("aria-pressed", "true");
  await expect(seg.getByRole("button", { name: "testnet" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText(/Fleet console · mainnet/i)).toBeVisible();

  // Flip back to Testnet — instant, no confirm.
  await seg.getByRole("button", { name: "testnet" }).click();
  await expect(seg.getByRole("button", { name: "testnet" })).toHaveAttribute("aria-pressed", "true");
});
