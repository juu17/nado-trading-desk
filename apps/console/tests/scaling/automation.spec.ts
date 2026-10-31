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
  // A small, cap-safe per-pair volume so a run is never refused by whatever per-order notional cap the
  // preview carries (testnet's default is generous, but keep these tests independent of the ambient cap).
  await page.getByLabel("Min volume per pair").fill("2");
  await page.getByLabel("Max volume per pair").fill("5");
}

test("automation-round-flow: Run self-crosses each maker↔taker pair (maker rests, taker IOC-crosses)", async ({ page }) => {
  const placed: string[] = [];
  await bootAndSplit(page, placed); // default wide 995/1005 book → an interior tick (~1000) exists

  await page.getByRole("button", { name: "Run automation" }).click();

  // Run is continuous, so the per-pair line + round tally repeat each round — assert on the first match.
  await expect(page.getByText(/^✓ pair 1: /).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^round complete: 1\/1 traded/).first()).toBeVisible();
  // Wiring proof: the pair submitted at least the maker's rest + the taker's cross through the relay.
  await expect.poll(() => placed.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);

  await page.getByRole("button", { name: "Pause automation" }).click(); // stop the loop
  await expect(page.getByText("■ stopped.")).toBeVisible({ timeout: 30_000 });
});

test("automation-tight-spread: a 1-tick book has no interior tick, so the pair is SKIPPED and the run stops", async ({ page }) => {
  const placed: string[] = [];
  // bid 2000.0 / ask 2000.1 — a 1-tick spread (tick 0.1). No tick strictly between → can't self-cross.
  await bootAndSplit(page, placed, {
    book: {
      bids: [["2000000000000000000000", "1000000000000000000"]],
      asks: [["2000100000000000000000", "1000000000000000000"]],
    },
  });

  await page.getByRole("button", { name: "Run automation" }).click();

  // The pair is skipped (no interior tick), so every round trades nothing and after a few the loop stops.
  await expect(page.getByText(/^⊘ pair 1 skipped/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/no pairs traded in \d+ rounds/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("■ stopped.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run automation" })).toBeVisible();
  // The tight spread is detected BEFORE any order is built, so nothing ever reached the relay.
  expect(placed.length).toBe(0);
});

test("automation-mainnet-confirm: on mainnet, Run opens a typed-RUN confirm; cancel places nothing", async ({ page }) => {
  const placed: string[] = [];
  await bootAndSplit(page, placed); // boots on testnet; the cohort is split (1M/1T)

  // Flip to mainnet via the network switch (confirm its real-funds alert); the cohort persists.
  await page.getByRole("button", { name: "mainnet" }).click();
  await page.getByRole("button", { name: "Switch to Mainnet" }).click();

  // Run is enabled on mainnet, but a click opens the typed-RUN confirm — it does NOT start a run.
  await page.getByRole("button", { name: "Run automation" }).click();
  await expect(page.getByText(/Run automation on MAINNET/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/real USDT0/i)).toBeVisible();
  // Cancel (Escape) dismisses it with nothing placed — the mainnet gate held.
  await page.keyboard.press("Escape");
  await expect(page.getByText(/Run automation on MAINNET/i)).toBeHidden();
  await expect(page.getByRole("button", { name: "Run automation" })).toBeVisible();
  expect(placed.length).toBe(0);
});

test("automation-run-pause: Run starts continuous rounds; Pause stops them", async ({ page }) => {
  const placed: string[] = [];
  await bootAndSplit(page, placed); // testnet, 1M/1T, wide book

  // Start → the toggle flips to Pause and rounds begin submitting orders through the relay.
  await page.getByRole("button", { name: "Run automation" }).click();
  await expect(page.getByRole("button", { name: "Pause automation" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => placed.length, { timeout: 30_000 }).toBeGreaterThan(0);

  // Pause → the loop aborts, the toggle returns to Run, and it logs that it stopped. (That the in-flight
  // pair's cleanup still FLATTENS on abort — cancel + reduce-only with no signal — is only provable with
  // real positions, i.e. OUTRIGHT on live testnet via NADO_LIVE; the mocked sequencer holds no position.)
  await page.getByRole("button", { name: "Pause automation" }).click();
  await expect(page.getByRole("button", { name: "Run automation" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("■ stopped.")).toBeVisible();
});

test("automation-metrics: a run increments the live Pairs metric (and the filmstrip drains off the same hooks)", async ({ page }) => {
  const placed: string[] = [];
  await bootAndSplit(page, placed); // testnet, 1M/1T, wide book → each round trades one pair

  await page.getByRole("button", { name: "Run automation" }).click();

  // The Pairs tile counts traded pairs live (same onPairEnd hook that drains the CohortFilmstrip queue;
  // the drain's visual reordering is best seen on a live run, but its data path is this metric).
  await expect
    .poll(async () => Number((await page.getByTestId("metric-pairs").textContent()) ?? "0"), { timeout: 30_000 })
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "Pause automation" }).click();
  await expect(page.getByText("■ stopped.")).toBeVisible({ timeout: 30_000 });
});
