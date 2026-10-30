// =============================================================================
// Wave 2b reporting: the ACCOUNTING view — the fleet activity ledger (AccountingView) backed by
// bulk.activity, previously untested end-to-end. We fire a real bulk run (so recordActivity fills
// bulk.activity), open Accounting from the home header, and assert the rollup renders: the order
// count, and the By-cohort / By-wallet aggregates derived from each record's side (buys/sells),
// notional (volume) and fee (fees). (AccountingView shows aggregates, not raw rows; the record
// field math is unit-tested in packages/ui/src/accounting.test.ts.)
// Real in-tab wative crypto + IndexedDB; sequencer/RPC mocked for determinism.
// =============================================================================
import { test, expect } from "@playwright/test";
import { mockState, mockRelay, mockNativeRpc, MockSequencer, unlockGeneratedCohort } from "../_helpers/mock-live";

test("accounting-flow: a bulk run populates the ledger; the Accounting view renders the rollup", async ({ page }) => {
  await new MockSequencer().install(page); // absorb the cohort's public WS so no real socket is attempted
  await mockState(page);
  await mockRelay(page);
  await mockNativeRpc(page);

  await page.goto("/");
  await unlockGeneratedCohort(page); // 3 in-tab live wallets

  // Fire the bulk action (Once) so three buy orders record into bulk.activity.
  await page.getByRole("button", { name: /^Run on 3 wallets$/ }).click();
  await page.getByLabel(/to confirm/i).fill("RUN");
  await page.locator("button", { hasText: "Confirm & run" }).click();
  await expect(page.getByText("done", { exact: true }).locator("xpath=following-sibling::strong")).toHaveText("3", { timeout: 20_000 });

  // Open the fleet accounting ledger from the home header.
  await page.getByRole("button", { name: "Accounting" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("3 orders")).toBeVisible(); // description = bulk.activity length

  // The two rollup tables render.
  await expect(dialog.getByText("By cohort")).toBeVisible();
  await expect(dialog.getByText("By wallet")).toBeVisible();

  // By-cohort row for the live cohort: 3 orders, 3 buys (side), and a non-zero volume (notional) — so the
  // record's side + notional actually flowed into the aggregate (columns: Cohort|Orders|Volume|Buys|Sells|Fees).
  // Match by the EXACT key cell ("LIVE") — a substring hasText would also catch the "live:N" wallet rows.
  const cohortRow = dialog.getByRole("row").filter({ has: page.getByRole("cell", { name: "LIVE", exact: true }) });
  await expect(cohortRow).toBeVisible();
  await expect(cohortRow.getByRole("cell").nth(1)).toHaveText("3");      // Orders
  await expect(cohortRow.getByRole("cell").nth(3)).toHaveText("3");      // Buys (all default-side buy)
  await expect(cohortRow.getByRole("cell").nth(2)).not.toHaveText("0.00"); // Volume (Σ notional) > 0
  await expect(cohortRow.getByRole("cell").nth(5)).not.toHaveText("0.0000"); // Fees (Σ fee) > 0

  // By-wallet rollup keys on walletId — one row per live wallet that traded.
  await expect(dialog.getByText("live:1")).toBeVisible();
});
