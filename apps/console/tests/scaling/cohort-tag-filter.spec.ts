// =============================================================================
// Tag + Cohort dimensions — the per-wallet labels and the maker/taker role, end to end.
// Tags and cohort are now REAL, editable, vault-persisted per-wallet state (wative Wallet tags):
// a fresh cohort starts with NO tags and NO cohort. This spec assigns both from the drawer
// (the (+) tag chip and the Maker/Taker switch), then proves each drives its sidebar filter.
// The pure filter arithmetic (incl. exclusion) is unit-tested in packages/ui/src/fleet.test.ts.
// Real in-tab wative crypto + IndexedDB; sequencer/RPC mocked for determinism.
// =============================================================================
import { test, expect } from "@playwright/test";
import { mockState, mockRelay, mockNativeRpc, MockSequencer, unlockGeneratedCohort } from "../_helpers/mock-live";

test("tag-and-cohort-flow: assign a tag + a maker cohort in the drawer, then filter the fleet by each", async ({ page }) => {
  await new MockSequencer().install(page); // absorb the cohort's public WS so no real socket is attempted
  await mockState(page);
  await mockRelay(page);
  await mockNativeRpc(page);

  await page.goto("/");
  await unlockGeneratedCohort(page); // 3 in-tab wallets, initially UNtagged + no cohort

  const cards = page.getByTestId("wallet-card");
  await expect(cards).toHaveCount(3, { timeout: 30_000 });

  // Open a non-treasury wallet (treasury is live:0) and edit its tags + cohort.
  await cards.nth(1).click();
  // The drawer is an <aside> (so is the Kumo sidebar) — scope to the one carrying the drawer's content.
  await expect(page.getByText(/Live stream \(WS\)/)).toBeVisible({ timeout: 30_000 });
  const drawer = page.locator("aside").filter({ hasText: "Live stream (WS)" });

  // Tags: the (+) chip opens an input; a new tag renders as a removable chip (persisted in the vault).
  await drawer.getByRole("button", { name: "Add tag" }).click();
  await drawer.getByRole("textbox", { name: "New tag" }).fill("mm-a");
  await drawer.getByRole("textbox", { name: "New tag" }).press("Enter");
  await expect(drawer.getByRole("button", { name: "Remove tag mm-a" })).toBeVisible({ timeout: 30_000 });

  // Cohort: the Maker/Taker switch assigns the role (mutually exclusive, persisted).
  const cohortGroup = drawer.getByRole("group", { name: "Cohort" });
  await cohortGroup.getByRole("button", { name: "maker" }).click();
  await expect(cohortGroup.getByRole("button", { name: "maker" })).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });

  await drawer.getByRole("button", { name: "Close", exact: true }).click(); // exact: avoid "Close position"

  // The active-wallet strip is split by cohort: the Maker row now counts the wallet we assigned.
  await expect(page.getByText("Maker · 1")).toBeVisible();

  // The sidebar now carries the new tag; its toggle filters the fleet to the one tagged wallet.
  const tagToggle = page.getByRole("button", { name: "mm-a", exact: true });
  await expect(tagToggle).toBeVisible();
  await tagToggle.click();
  await expect(tagToggle).toHaveAttribute("aria-pressed", "true");
  await expect(cards).toHaveCount(1);
  await tagToggle.click();
  await expect(cards).toHaveCount(3);

  // The Cohort filter (always Maker/Taker) narrows to the one wallet we made a maker.
  const makerToggle = page.getByRole("button", { name: "maker", exact: true });
  await makerToggle.click();
  await expect(cards).toHaveCount(1);
  await makerToggle.click();
  await expect(cards).toHaveCount(3);
});
