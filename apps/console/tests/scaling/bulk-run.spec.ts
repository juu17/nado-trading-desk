// =============================================================================
// Wave 2b core: the BULK ORDER-PLACEMENT FAN-OUT — UI-FLOW WIRING ONLY. bulk-schedule.spec.ts
// deliberately uses Cron (never fires a job); THIS spec drives Schedule=Once so the shipped BulkPanel
// path runs end to end: unlock a 3-wallet cohort → confirm → the scheduler fans one job per wallet →
// each order is built + signed IN-TAB → POST to /api/nado/relay/execute.
// 🚨 The sequencer is MOCKED at the browser edge (mockRelay answers the place_order EXECUTE), so this
// verifies the FLOW — clicks → per-wallet fan-out → a signed submit per wallet (with per-wallet SIZE
// jitter visible in the signed payload) → the failure/retry state machine → the done/failed UI — and
// NOT that order placement itself works. Order placement is verified OUTRIGHT on REAL TESTNET by the
// NADO_LIVE-gated runners (e.g. packages/adapter-nado/scripts/testnet-loop.mjs), which place real
// orders; a browser-mocked pass here is never proof that placement settles. No mainnet, ever.
// Real in-tab wative crypto + IndexedDB; sequencer/RPC mocked for determinism.
// =============================================================================
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mockState, mockRelay, mockNativeRpc, MockSequencer } from "../_helpers/mock-live";
import { unlockGeneratedCohort } from "../_helpers/mock-live";

/** The signed size (X18, from the place_order EIP-712 order) of each submit the relay saw, in order. */
function amountOf(payload: Record<string, unknown>): string | undefined {
  const order = payload.order as { amount?: unknown } | undefined;
  return order?.amount != null ? String(order.amount) : undefined;
}

/** The stats-row count next to a label ("done" / "failed") — <span>LABEL</span> <strong>N</strong>. */
function statCount(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator("xpath=following-sibling::strong");
}

/** Fire the bulk action's typed-RUN confirm (DANGER mode, because the targets are live wallets). */
async function confirmRun(page: Page): Promise<void> {
  await page.getByLabel(/to confirm/i).fill("RUN");
  await page.locator("button", { hasText: "Confirm & run" }).click();
}

test("bulk-run-flow: Once fans one signed order per wallet; sizes vary (per-wallet jitter); all reach done", async ({ page }) => {
  const placed: string[] = []; // each place_order's signed size (order.amount)
  await new MockSequencer().install(page); // absorb the cohort's public WS so no real socket is attempted
  await mockState(page);
  await mockRelay(page, {
    onExecute: (kind, payload) => { if (kind === "place_order") { const a = amountOf(payload); if (a) placed.push(a); } },
  });
  await mockNativeRpc(page);

  await page.goto("/");
  await unlockGeneratedCohort(page); // 3 in-tab live wallets (live:0 treasury + live:1 + live:2)

  // Defaults: Schedule=Once, Size jitter 0.1–0.5, Price jitter 63120–63500. Fire on the 3 live wallets.
  await page.getByRole("button", { name: /^Run on 3 wallets$/ }).click();
  await confirmRun(page); // live targets → DANGER-mode typed RUN confirm

  // All three jobs completed (the done counter reaches 3 and nothing failed).
  await expect(statCount(page, "done")).toHaveText("3", { timeout: 20_000 });
  await expect(page.getByText("failed", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);

  // Exactly three signed orders reached the (mocked) relay — one per wallet (the fan-out) — and their
  // sizes VARY: proof the per-wallet jitter fired (jitter OFF → every wallet signs the identical amount).
  // This asserts the SUBMIT WIRING + payload shaping, not that the sequencer would accept/place them.
  expect(placed).toHaveLength(3);
  expect(new Set(placed).size).toBeGreaterThanOrEqual(2);
});

test("bulk-run-flow: a sequencer rejection lands jobs failed, then Retry recovers them to done", async ({ page }) => {
  let failSubmits = true; // the sequencer rejects every submit until the test flips this
  let placeCalls = 0;
  await new MockSequencer().install(page);
  await mockState(page);
  await mockRelay(page, {
    placeOrderFails: () => failSubmits,
    onExecute: (kind) => { if (kind === "place_order") placeCalls++; },
  });
  await mockNativeRpc(page);

  await page.goto("/");
  await unlockGeneratedCohort(page);

  // First fire: every submit is rejected → all three jobs land FAILED (never silently "done").
  await page.getByRole("button", { name: /^Run on 3 wallets$/ }).click();
  await confirmRun(page);
  await expect(statCount(page, "failed")).toHaveText("3", { timeout: 20_000 });
  await expect(statCount(page, "done")).toHaveText("0");
  const retry = page.getByRole("button", { name: /^Retry 3 failed$/ });
  await expect(retry).toBeVisible();
  expect(placeCalls).toBe(3); // the three submits actually reached the relay and were rejected

  // Stop rejecting, then retry ONLY the failed jobs → they re-sign (byte-identical) and succeed.
  failSubmits = false;
  await retry.click();
  await expect(statCount(page, "done")).toHaveText("3", { timeout: 20_000 });
  await expect(page.getByText("failed", { exact: true })).toHaveCount(0); // failed → 0 (the label drops)
  await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  expect(placeCalls).toBe(6); // 3 rejected + 3 retried-and-accepted
});
