// =============================================================================
// SPEND-CAP rejection gate — proves the live-path caps actually FIRE (the main suite only
// proves they don't BREAK normal flows). Runs under playwright.caps.config.ts, which boots a
// dev server with DELIBERATELY LOW caps baked in via NEXT_PUBLIC_* (order 10 USDT0, deposit
// 10 USDT0, refuel 0.001 ETH, cohort 15 USDT0), so small, obvious inputs trip every ceiling.
//
// Each cap is a LOUD REJECT before any signing/broadcast: the order cap throws in-tab before
// the relay submit; deposit/refuel return {ok:false} before the on-chain broadcast; the cohort
// caps throw (fail-fast up front, or the cumulative ceiling mid-run). Mocks mirror refuel.spec
// (real in-tab signing; mocked sequencer + Ink RPC), so a breach is deterministic and offline.
// =============================================================================
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mockState, mockRelay, mockInkRpc, MockSequencer, unlockGeneratedCohort } from "../_helpers/mock-live";

const PUBLIC_SUBS = 3 * 2; // 3 generated subaccounts × {fill, position_change}
const ONE_ETH = 1_000_000_000_000_000_000n;

/** Open the Nth LIVE wallet card's drawer (0 = live:0 = the treasury). */
async function openLiveDrawer(page: Page, n: number) {
  const card = page.getByTestId("wallet-card").nth(n);
  await card.click();
  await expect(page.getByText(/Live stream \(WS\)/)).toBeVisible();
}

async function bootCohort(page: Page, seq: MockSequencer) {
  await page.goto("/");
  await unlockGeneratedCohort(page);
  await expect.poll(() => seq.subscribes.length, { timeout: 15_000 }).toBe(PUBLIC_SUBS);
}

test("order-cap: an order whose notional exceeds the cap is rejected in-tab, never submitted", async ({ page }) => {
  const seq = new MockSequencer();
  await seq.install(page);
  await mockState(page);
  await mockRelay(page);
  await mockInkRpc(page, { defaultWei: ONE_ETH });
  await bootCohort(page, seq);

  await openLiveDrawer(page, 1); // a non-treasury live wallet
  // The drawer defaults (size 0.1 × price 63120 = 6312 USDT0 notional) already exceed the low
  // order cap (10), so a plain maker submit must be rejected by the cap — not placed.
  await page.getByRole("button", { name: "Sign & submit" }).click();

  await expect(page.getByText(/order notional .* exceeds cap 10/)).toBeVisible({ timeout: 10_000 });
  // The cap throws BEFORE the adapter submit, so no order was ever placed (no success line).
  await expect(page.getByText(/✓ (buy|sell) /)).toHaveCount(0);
});

test("deposit-cap: a deposit over the cap returns a loud error and never broadcasts", async ({ page }) => {
  const methods: string[] = [];
  const seq = new MockSequencer();
  await seq.install(page);
  await mockState(page);
  await mockRelay(page);
  await mockInkRpc(page, { defaultWei: ONE_ETH, onCall: (m) => methods.push(m) });
  await bootCohort(page, seq);

  await openLiveDrawer(page, 1);
  // The Funding "Amount" field defaults to 100 USDT0, over the low deposit cap (10).
  await page.getByRole("button", { name: "Deposit" }).click();
  await page.getByLabel(/to confirm/i).fill("RUN");
  await page.locator("button", { hasText: "Confirm & run" }).click();

  await expect(page.getByText(/✗ deposit 100 USDT0 — .*exceeds cap 10/)).toBeVisible({ timeout: 10_000 });
  // The cap returns before any approve/deposit tx — nothing was broadcast.
  expect(methods).not.toContain("eth_sendRawTransaction");
});

test("refuel-cap: a refuel over the cap returns a loud error before taking the treasury nonce lane", async ({ page }) => {
  const methods: string[] = [];
  const seq = new MockSequencer();
  await seq.install(page);
  await mockState(page);
  await mockRelay(page);
  await mockInkRpc(page, { defaultWei: ONE_ETH, onCall: (m) => methods.push(m) });
  await bootCohort(page, seq);

  await openLiveDrawer(page, 1); // non-treasury → the refuel control is present
  await page.getByLabel("ETH amount").fill("0.01"); // over the low refuel cap (0.001), under treasury's 1 ETH
  await page.getByRole("button", { name: "Refuel gas" }).click();
  await page.getByLabel(/to confirm/i).fill("RUN");
  await page.locator("button", { hasText: "Confirm & run" }).click();

  await expect(page.getByText(/✗ refuel 0\.01 ETH — .*exceeds cap 0\.001/)).toBeVisible({ timeout: 10_000 });
  expect(methods).not.toContain("eth_sendRawTransaction");
});

// (cohort-cap fail-fast + cumulative removed with the FundingPanel — bulk cohort funding is no longer in
// the console UI; the per-wallet deposit cap stays covered by the deposit-cap test above. The cohort-level
// cumulative cap still lives in fundCohortLive, exercised by the headless fund-cohort.mjs path.)
