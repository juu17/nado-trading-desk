// Wave 2b: the bulk-action schedule picker (Once / Every N / Cron). Drives the real BulkPanel UI —
// cron expressions are validated IN-BROWSER via @farm/core parseCron, and a recurring schedule starts
// via runTemplate + stops via its handle. The BulkPanel targets the SHOWN wallets, so (now the mock
// fleet is gone) we unlock a real in-tab cohort first; cron does NOT fire immediately, so starting one
// issues no orders during the test (and the sequencer/RPC are mocked besides).
import { test, expect } from "@playwright/test";
import { mockState, mockRelay, mockNativeRpc, MockSequencer, unlockGeneratedCohort } from "../_helpers/mock-live";

test("bulk-schedule-flow: cron validation + start/stop a recurring schedule", async ({ page }) => {
  await new MockSequencer().install(page); // absorb the cohort's public WS so no real socket is attempted
  await mockState(page);
  await mockRelay(page);
  await mockNativeRpc(page);
  await page.goto("/");
  await unlockGeneratedCohort(page); // the BulkPanel needs real in-tab wallets now the mock fleet is gone

  // Switch the bulk-action schedule to Cron.
  await page.getByRole("button", { name: "Cron", exact: true }).click();
  const cronInput = page.getByPlaceholder("*/15 * * * *");
  const startBtn = page.getByRole("button", { name: /Start schedule on/ });

  // A malformed expr is flagged invalid (parseCron in the browser) and disables Start.
  await cronInput.fill("nope");
  await expect(page.getByText("✗ invalid")).toBeVisible();
  await expect(startBtn).toBeDisabled();

  // A valid expr clears the error and enables Start.
  await cronInput.fill("*/15 * * * *");
  await expect(page.getByText("✗ invalid")).toHaveCount(0);
  await expect(startBtn).toBeEnabled();

  // Start the schedule through the typed-RUN confirm; cron waits for the next match, so nothing fires now.
  await startBtn.click();
  await page.getByLabel(/to confirm/i).fill("RUN");
  await page.locator("button", { hasText: "Confirm & run" }).click(); // the button, not Kumo's contents-span
  await expect(page.getByText(/Schedule running/)).toBeVisible();

  // Stop it — the running indicator clears.
  await page.getByRole("button", { name: "Stop schedule", exact: true }).click();
  await expect(page.getByText(/Schedule running/)).toHaveCount(0);
});

test("bulk-schedule-flow: the kill switch stops a running schedule", async ({ page }) => {
  await new MockSequencer().install(page); // absorb the cohort's public WS so no real socket is attempted
  await mockState(page);
  await mockRelay(page);
  await mockNativeRpc(page);
  await page.goto("/");
  await unlockGeneratedCohort(page); // the BulkPanel needs real in-tab wallets now the mock fleet is gone

  await page.getByRole("button", { name: "Cron", exact: true }).click();
  await page.getByPlaceholder("*/15 * * * *").fill("*/15 * * * *");
  await page.getByRole("button", { name: /Start schedule on/ }).click();
  await page.getByLabel(/to confirm/i).fill("RUN");
  await page.locator("button", { hasText: "Confirm & run" }).click();
  await expect(page.getByText(/Schedule running/)).toBeVisible();

  // The kill switch must stop the SCHEDULE (future fires), not just halt in-flight jobs.
  await page.getByRole("button", { name: "Kill switch", exact: true }).click();
  await expect(page.getByText(/Schedule running/)).toHaveCount(0);

  // Recovery: a fresh start after a kill must work (the scheduler is un-halted + stale jobs cleared),
  // not dead-end on a stuck halt.
  await page.getByRole("button", { name: /Start schedule on/ }).click();
  await page.getByLabel(/to confirm/i).fill("RUN");
  await page.locator("button", { hasText: "Confirm & run" }).click();
  await expect(page.getByText(/Schedule running/)).toBeVisible();
});

test("bulk-schedule-flow: an impossible cron surfaces an error and never sticks as running", async ({ page }) => {
  await new MockSequencer().install(page); // absorb the cohort's public WS so no real socket is attempted
  await mockState(page);
  await mockRelay(page);
  await mockNativeRpc(page);
  await page.goto("/");
  await unlockGeneratedCohort(page); // the BulkPanel needs real in-tab wallets now the mock fleet is gone

  await page.getByRole("button", { name: "Cron", exact: true }).click();
  // Valid SYNTAX but an impossible date (Feb 30) — passes the syntax check, fails at schedule START.
  await page.getByPlaceholder("*/15 * * * *").fill("0 0 30 2 *");
  await expect(page.getByRole("button", { name: /Start schedule on/ })).toBeEnabled();
  await page.getByRole("button", { name: /Start schedule on/ }).click();
  await page.getByLabel(/to confirm/i).fill("RUN");
  await page.locator("button", { hasText: "Confirm & run" }).click();

  // The schedule must NOT stick as running; the error surfaces instead (no stuck "Schedule running").
  await expect(page.getByText(/schedule error/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Schedule running/)).toHaveCount(0);
});
