// =============================================================================
// Trading strategy (Wave B) — the self-cross round. After the Cohort split, "Run automation" trades
// every maker↔taker pair once: the maker rests post-only at a tick INSIDE the spread and the taker
// IOC-crosses to that same price, then both flatten. These assert the UI→engine WIRING — orders are
// built + submitted through the in-tab primitives and the round accounts its pairs — and that a book too
// tight for a clean self-cross is SKIPPED, not forced into third-party liquidity. NOT placement proof:
// the sequencer + RPC are mocked, so real fills are verified OUTRIGHT on live testnet (NADO_LIVE), never
// from this mocked gate. Real in-tab wative crypto + IndexedDB; sequencer/RPC mocked for determinism.
// =============================================================================
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mockState, mockRelay, mockNativeRpc, MockSequencer, unlockGeneratedCohort, liveConfig } from "../_helpers/mock-live";

// BTC-PERP in the market picker (the canned config ships products but an EMPTY markets list), so the
// default-market effect selects it; the engine resolves it to the canned product (tick 0.1).
const MARKET = { id: "nado:perp:BTC-PERP", symbol: "BTC-PERP", kind: "perp", tickSize: "0.1", minSize: "0.001" };

/** Boot a 3-wallet cohort and split it → 1 maker + 1 taker (+1 unassigned) → one maker↔taker pair. */
async function bootAndSplit(page: Page, placed: string[], opts: { book?: { bids: [string, string][]; asks: [string, string][] } } = {}) {
  await new MockSequencer().install(page);
  await mockState(page, liveConfig({ markets: [MARKET] }));
  await mockRelay(page, { book: opts.book, onExecute: (kind) => { if (kind === "place_order") placed.push(kind); } });
  await mockNativeRpc(page);

  await page.goto("/");
  await unlockGeneratedCohort(page); // 3 in-tab wallets, all un-cohorted
  await expect(page.getByTestId("wallet-card")).toHaveCount(3, { timeout: 30_000 });
  await page.getByRole("button", { name: /^Cohort · / }).click();
  await expect(page.getByRole("button", { name: "Cohort · 1M / 1T" })).toBeVisible({ timeout: 30_000 });
}

test("automation-round-flow: Run trades the split cohort once (maker rests, taker IOC-crosses) and logs round complete", async ({ page }) => {
  const placed: string[] = [];
  await bootAndSplit(page, placed); // default wide 995/1005 book → an interior tick (~1000) exists

  await page.getByRole("button", { name: "Run automation" }).click();

  // The pair's self-cross (maker side ↔ taker side) is logged, then a round-complete tally.
  await expect(page.getByText(/^✓ pair 1: /)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("round complete: 1/1 traded")).toBeVisible();
  // Wiring proof: the pair submitted at least the maker's rest + the taker's cross through the relay.
  expect(placed.length).toBeGreaterThanOrEqual(2);
});

test("automation-tight-spread: a 1-tick book has no interior tick, so the pair is SKIPPED — no orders placed", async ({ page }) => {
  const placed: string[] = [];
  // bid 2000.0 / ask 2000.1 — a 1-tick spread (tick 0.1). No tick strictly between → can't self-cross.
  await bootAndSplit(page, placed, {
    book: {
      bids: [["2000000000000000000000", "1000000000000000000"]],
      asks: [["2000100000000000000000", "1000000000000000000"]],
    },
  });

  await page.getByRole("button", { name: "Run automation" }).click();

  await expect(page.getByText(/^⊘ pair 1 skipped/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("round complete: 0/1 traded, 1 skipped")).toBeVisible();
  // The tight spread is detected BEFORE any order is built, so nothing reached the relay.
  expect(placed.length).toBe(0);
});

test("automation-mainnet-gate: switching to mainnet disables Run until the typed-confirm wave — no automated placement", async ({ page }) => {
  const placed: string[] = [];
  await bootAndSplit(page, placed); // boots on testnet; the cohort is split (1M/1T)

  // Flip to mainnet via the network switch (confirm its real-funds alert). The cohort persists (custody
  // is chain-agnostic), so with a maker AND a taker present the ONLY remaining reason Run is disabled is
  // the testnet gate — mainnet automation needs its confirm step (a later wave).
  await page.getByRole("button", { name: "mainnet" }).click();
  await page.getByRole("button", { name: "Switch to Mainnet" }).click();

  await expect(page.getByText("Testnet only — mainnet automation ships with its confirm step.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Run automation" })).toBeDisabled();
  expect(placed.length).toBe(0);
});
