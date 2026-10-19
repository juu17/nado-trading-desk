// =============================================================================
// Deposit-address (Nado DDA) drawer section: for a LIVE wallet, the drawer fetches the wallet's
// per-subaccount Direct Deposit Address from the keyless indexer (mocked here) and renders it
// with a QR code at the bottom. Real in-tab cohort; sequencer/RPC/DDA mocked for determinism.
// =============================================================================
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mockState, mockRelay, mockInkRpc, mockDda, MockSequencer, unlockGeneratedCohort } from "../_helpers/mock-live";

const PUBLIC_SUBS = 3 * 2;
const ONE_ETH = 1_000_000_000_000_000_000n;
const DDA = "0x000000000000000000000000000000000000dDA1"; // canned per-subaccount deposit address

async function openLiveDrawer(page: Page, n: number) {
  await page.getByTestId("wallet-card").nth(n).click();
  await expect(page.getByText(/Live stream \(WS\)/)).toBeVisible();
}

test("deposit-address-flow: the drawer shows the wallet's Nado DDA + a QR code", async ({ page }) => {
  const seq = new MockSequencer();
  await seq.install(page);
  await mockState(page);
  await mockRelay(page);
  await mockInkRpc(page, { defaultWei: ONE_ETH });
  await mockDda(page, DDA);

  await page.goto("/");
  await unlockGeneratedCohort(page);
  await expect.poll(() => seq.subscribes.length, { timeout: 15_000 }).toBe(PUBLIC_SUBS);

  await openLiveDrawer(page, 1);
  // The drawer renders the wallet's Balances section (empty in the mock → the empty-state copy),
  // and its header toggles the list collapsed/expanded.
  await expect(page.getByText(/No collateral balances yet/i)).toBeVisible();
  await page.getByRole("button", { name: /^Balances/ }).click();
  await expect(page.getByText(/No collateral balances yet/i)).toHaveCount(0); // collapsed
  await page.getByRole("button", { name: /^Balances/ }).click();
  await expect(page.getByText(/No collateral balances yet/i)).toBeVisible();  // expanded again
  // The DDA section text is unique to the drawer (the sidebar <aside> has none of it), so match
  // page-wide; scope only the QR <svg> to the drawer aside.
  await expect(page.getByText(/Deposit address \(Nado DDA\)/i)).toBeVisible();
  await expect(page.getByText(new RegExp(DDA, "i"))).toBeVisible();      // the address itself
  await expect(page.getByText(/Send USDT0 on Ink/i)).toBeVisible();      // the section's note
  const drawer = page.locator("aside").filter({ hasText: "Deposit address (Nado DDA)" });
  // Scoped to the QR's own hook: the drawer now carries Phosphor icons (close, copy, caret) ahead of
  // the QR, so `svg.first()` would match an icon and pass even with no QR rendered.
  await expect(drawer.getByTestId("dda-qr").locator("svg")).toBeVisible(); // the rendered QR
});
