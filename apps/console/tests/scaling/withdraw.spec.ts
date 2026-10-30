// =============================================================================
// Wave 2b funding: WITHDRAW collateral — UI-FLOW WIRING ONLY. The in-tab EIP-712 → keyless relay
// withdraw path had ZERO e2e coverage (deposit/refuel/mint were covered; withdraw wasn't). Drives the
// shipped drawer Funding control: withdrawLive fetches a tx nonce via /query, builds + signs the Nado
// `withdraw_collateral` EIP-712 IN-TAB, and POSTs the signed payload to /api/nado/relay/execute.
// 🚨 The sequencer is MOCKED at the browser edge (mockRelay answers the nonce read + the execute), so
// this verifies the FLOW — set amount → confirm → in-tab sign → a signed submit is made → the logged
// outcome — and NOT that the withdraw itself settles. The withdraw/relay submit is verified OUTRIGHT on
// REAL TESTNET by the NADO_LIVE-gated runners, never by a browser mock. No mainnet, ever. Keyless
// SIGNING is real (in-tab crypto needs no network); only the relay reads/submit are mocked.
// =============================================================================
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mockState, mockRelay, mockNativeRpc, MockSequencer, unlockGeneratedCohort } from "../_helpers/mock-live";

/** Open the Nth LIVE wallet card's drawer (0 = live:0 = the treasury). */
async function openLiveDrawer(page: Page, n: number): Promise<void> {
  await page.getByTestId("wallet-card").nth(n).click();
  await expect(page.getByText(/Live stream \(WS\)/)).toBeVisible();
}

test("withdraw-flow: signs a Nado EIP-712 in-tab, relays the withdraw, and logs the accepted submission", async ({ page }) => {
  const executes: string[] = []; // the write kinds the relay saw, in order
  await new MockSequencer().install(page); // absorb the cohort's public WS so no real socket is attempted
  await mockState(page);
  await mockRelay(page, { onExecute: (kind) => executes.push(kind) });
  await mockNativeRpc(page);

  await page.goto("/");
  await unlockGeneratedCohort(page); // 3 in-tab live wallets

  await openLiveDrawer(page, 1); // a non-treasury live wallet
  // Funding section: set the amount, then Withdraw → the drawer's DANGER-mode typed-RUN confirm.
  await page.getByLabel("Amount", { exact: true }).fill("25");
  await page.getByRole("button", { name: "Withdraw" }).click();
  await page.getByLabel(/to confirm/i).fill("RUN");
  await page.locator("button", { hasText: "Confirm & run" }).click();

  // The full in-tab sign → relay submit completed and the accepted submission is logged (✓, not ✗).
  await expect(page.getByText(/✓ withdraw 25 USDT0 submitted.*success/)).toBeVisible({ timeout: 15_000 });
  // The real signed withdraw_collateral payload actually reached the relay's /execute.
  expect(executes).toContain("withdraw_collateral");
});
