// =============================================================================
// Cumulative-cap gate for the self-cross automation. Runs under playwright.caps.config.ts, whose server
// bakes in tiny caps (order 10, cohort 15, WALLET 8 USDT0). With a fixed $5/pair volume: round 1 trades
// (each wallet's running total → 5); round 2 would push a wallet to 10 > the $8 per-wallet cap, so the
// pair is skipped as wallet-capped and — nothing having traded — the run stops itself. Proves the
// per-wallet cumulative cap actually bounds a run (the main suite only proves caps don't break trading).
// Mocks mirror the automation specs (real in-tab crypto; mocked sequencer + RPC).
// =============================================================================
import { test, expect } from "@playwright/test";
import { mockState, mockRelay, mockNativeRpc, MockSequencer, unlockGeneratedCohort, liveConfig } from "../_helpers/mock-live";

const MARKET = { id: "nado:perp:BTC-PERP", symbol: "BTC-PERP", kind: "perp", tickSize: "0.1", minSize: "0.001" };

test("automation-wallet-cap: the per-wallet cumulative cap stops the run", async ({ page }) => {
  const placed: string[] = [];
  await new MockSequencer().install(page);
  await mockState(page, liveConfig({ markets: [MARKET] }));
  await mockRelay(page, { onExecute: (kind) => { if (kind === "place_order") placed.push(kind); } });
  await mockNativeRpc(page);

  await page.goto("/");
  await unlockGeneratedCohort(page); // 3 in-tab wallets, all un-cohorted
  await page.getByRole("button", { name: /^Cohort · / }).click();
  await expect(page.getByRole("button", { name: "Cohort · 1M / 1T" })).toBeVisible({ timeout: 30_000 });

  // Fixed $5/pair (under the $10 order cap) so the per-wallet accumulation is deterministic.
  await page.getByLabel("Min volume per pair").fill("5");
  await page.getByLabel("Max volume per pair").fill("5");
  await page.getByRole("button", { name: "Run automation" }).click();

  // Round 2's pair is cap-skipped, the round trades nothing, and the loop self-stops.
  await expect(page.getByText(/wallet cap/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("■ stopped.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Run automation" })).toBeVisible();
  // Only round 1's pair reached the relay (maker + taker); the cap-skipped pair placed nothing.
  expect(placed.length).toBe(2);
});
