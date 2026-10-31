// =============================================================================
// Trading strategy (Wave A) — the Cohort pre-step: clicking "Cohort" randomly splits every UN-cohorted
// wallet 50/50 into maker/taker (persisted via wative Wallet tags), which the filmstrip + sidebar Cohort
// filter reflect. 3 in-tab wallets → 1 maker + 1 taker + 1 left unassigned (odd one out). Real in-tab
// wative crypto + IndexedDB; sequencer/RPC mocked for determinism.
// =============================================================================
import { test, expect } from "@playwright/test";
import { mockState, mockRelay, mockNativeRpc, MockSequencer, unlockGeneratedCohort } from "../_helpers/mock-live";

test("cohort-split-flow: the Cohort button randomly splits un-cohorted wallets 50/50 into maker/taker", async ({ page }) => {
  await new MockSequencer().install(page);
  await mockState(page);
  await mockRelay(page);
  await mockNativeRpc(page);

  await page.goto("/");
  await unlockGeneratedCohort(page); // 3 in-tab wallets, all un-cohorted

  await expect(page.getByTestId("wallet-card")).toHaveCount(3, { timeout: 30_000 });

  // No cohort yet → the filmstrip's Maker/Taker rows aren't shown.
  await expect(page.getByText(/^Maker · /)).toHaveCount(0);

  // The Cohort pre-step button shows its live counts (0M / 0T) and splits the un-cohorted pool.
  await page.getByRole("button", { name: /^Cohort · / }).click();

  // 3 wallets → 1 maker + 1 taker (the odd one stays unassigned); the filmstrip now shows both rows,
  // and the button label reflects the new counts.
  // exact: true so these match only the filmstrip's "<label> · <count>" span — not the log line's
  // "…+1 taker · 1 left…" substring (getByText is a case-insensitive substring match by default).
  await expect(page.getByText("Maker · 1", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Taker · 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cohort · 1M / 1T" })).toBeVisible();
});
