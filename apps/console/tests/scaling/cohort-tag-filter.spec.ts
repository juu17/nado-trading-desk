// =============================================================================
// Sidebar "Cohorts (tags)" dimension — the second fleet filter (the Account filter is covered by
// account-filter.spec.ts; the cohort-tag toggle wasn't). The live home fleet tags EVERY wallet
// with the single "LIVE" cohort (live.ts hardcodes cohorts:[LIVE_COHORT] per wallet), so the
// dimension surfaces one toggle and selecting it can't reduce the shown set. This spec therefore
// proves the UI wiring: the toggle registers (aria-pressed) AND actually drives filterWallets so
// matching wallets STAY shown (a filter regression that inverted the cohort predicate would hide
// them). filterWallets' cohort arithmetic — including EXCLUSION of non-matching wallets — is
// exhaustively unit-tested in packages/ui/src/fleet.test.ts.
// Real in-tab wative crypto + IndexedDB; sequencer/RPC mocked for determinism.
// =============================================================================
import { test, expect } from "@playwright/test";
import { mockState, mockRelay, mockNativeRpc, MockSequencer, unlockGeneratedCohort } from "../_helpers/mock-live";

test("cohort-tag-filter-flow: the Cohorts (tags) toggle drives the fleet filter and keeps matching wallets", async ({ page }) => {
  await new MockSequencer().install(page); // absorb the cohort's public WS so no real socket is attempted
  await mockState(page);
  await mockRelay(page);
  await mockNativeRpc(page);

  await page.goto("/");
  await unlockGeneratedCohort(page); // 3 in-tab live wallets, each tagged the single "LIVE" cohort

  const cards = page.getByTestId("wallet-card");
  await expect(cards).toHaveCount(3, { timeout: 30_000 });

  // The cohort-tag dimension renders one toggle for the only cohort present, initially unpressed.
  const liveTag = page.getByRole("button", { name: "LIVE", exact: true });
  await expect(liveTag).toHaveAttribute("aria-pressed", "false");

  // Select it → the toggle registers and every wallet carrying that tag stays shown (the include path).
  await liveTag.click();
  await expect(liveTag).toHaveAttribute("aria-pressed", "true");
  await expect(cards).toHaveCount(3);

  // Deselect → the cohort filter clears; the fleet is unfiltered again.
  await liveTag.click();
  await expect(liveTag).toHaveAttribute("aria-pressed", "false");
  await expect(cards).toHaveCount(3);
});
