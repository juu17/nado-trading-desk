// =============================================================================
// Monkey-test Flows for the live WS subscribe -> route -> per-wallet reconcile -> UI path
// (the scaling epic's read-decoupling). Previously only STATICALLY audited; this drives the
// REAL shipped path in a browser: real in-tab custody (wative-core + IndexedDB) unlocks a
// cohort, the real openLiveStream opens the public socket, and a pure-mock sequencer (no real
// testnet) feeds deterministic frames + reads. Each test gets a fresh ephemeral context, so the
// custody IndexedDB starts clean — no cross-test leak.
//
// Oracle note: the budget-paced reconcile sweep reads every cohort wallet continuously, so the
// O(active)-not-O(cohort) read-AMOUNT property is NOT cleanly assertable here (that is a unit-
// level concern). What IS cleanly provable end-to-end: the subscribe fan-out, frame ingestion
// (the sweep-independent "N events" counter), a reconcile landing fresh data in the UI, and the
// ROUTING GUARD via a non-cohort subaccount (never swept, so "ingested but never read" is an
// unambiguous signal).
// =============================================================================
import { test, expect } from "@playwright/test";
import { mockState, mockRelay, mockNativeRpc, querySubaccount, MockSequencer, passGate, generateCohortViaPanel, unlockGeneratedCohort } from "../_helpers/mock-live";

const COHORT_N = 3;
const PUBLIC_SUBS = COHORT_N * 2; // each subaccount subscribes both fill + position_change
const UNKNOWN_SUBACCOUNT = "0x" + "9".repeat(64); // valid bytes32 shape, never a generated cohort member

test("ws-subscribe-flow: unlock cohort -> WS live + fill & position_change subscribed per subaccount", async ({ page }) => {
  const seq = new MockSequencer();
  await seq.install(page);
  await mockState(page);
  await mockRelay(page);
  await mockNativeRpc(page);

  await page.goto("/");
  // Past the entry gate the app renders; the cohort is still empty, so the header shows "locked".
  await passGate(page);
  await expect(page.getByText(/LIVE testnet · locked/)).toBeVisible();

  await generateCohortViaPanel(page);

  // Wait for ALL public subscribe frames (3 subaccounts x {fill, position_change}) before asserting
  // per-subaccount types — publicSubaccounts() counts a subaccount on its first frame, so gating on
  // the full count avoids racing the trailing position_change subscribe.
  await expect.poll(() => seq.subscribes.length, { timeout: 15_000 }).toBe(PUBLIC_SUBS);
  expect(seq.publicSubaccounts()).toHaveLength(COHORT_N);
  for (const sub of seq.publicSubaccounts()) {
    expect(seq.typesFor(sub)).toEqual(expect.arrayContaining(["fill", "position_change"]));
  }
  await expect(page.getByText(new RegExp(`LIVE testnet · ${COHORT_N} EOAs`))).toBeVisible();
  await expect(page.getByText(/WS live/)).toBeVisible();
});

test("ws-ingest-flow: fill + position_change frames increment the events counter and render in the drawer", async ({ page }) => {
  const seq = new MockSequencer();
  await seq.install(page);
  await mockState(page);
  await mockRelay(page);
  await mockNativeRpc(page);

  await page.goto("/");
  await unlockGeneratedCohort(page);
  await expect.poll(() => seq.subscribes.length, { timeout: 15_000 }).toBe(PUBLIC_SUBS);
  const subs = seq.publicSubaccounts();

  // Open a live wallet's drawer (also opens the authed order_update socket — the mock acks it).
  await page.getByTestId("wallet-card").first().click();
  await expect(page.getByText(/Live stream \(WS\)/)).toBeVisible();

  // Three frames: two for THIS drawer's wallet (sub0) + one for a DIFFERENT wallet (sub1). The header
  // counter is driven SOLELY by WS onEvent (sweep-independent) and is GLOBAL, so it counts all three.
  seq.emitFill(subs[0]!);
  seq.emitPositionChange(subs[0]!, "settle_pnl");
  seq.emitPositionChange(subs[1]!, "liquidation"); // a NON-drawer wallet's event
  await expect(page.getByText(/· 3 events/)).toBeVisible({ timeout: 5_000 });

  // The drawer feed is FILTERED to this wallet: sub0's fill + position_change render (the
  // position_change row also proves the W3 path end-to-end)...
  await expect(page.getByText(/position_change · settle_pnl/)).toBeVisible();
  await expect(page.getByText(/^fill/)).toBeVisible();
  // ...but the other wallet's (sub1) event must NOT leak into this wallet's drawer feed.
  await expect(page.getByText(/position_change · liquidation/)).toHaveCount(0);
});

test("ws-reconcile-data-flow: a fill reconciles that wallet's open-order count into its card", async ({ page }) => {
  const orders = new Map<string, number>();
  const seq = new MockSequencer();
  await seq.install(page);
  await mockState(page);
  await mockRelay(page, { orders }); // live reference: mutate after unlock to drive the reconcile
  await mockNativeRpc(page);

  await page.goto("/");
  await unlockGeneratedCohort(page);
  await expect.poll(() => seq.subscribes.length, { timeout: 15_000 }).toBe(PUBLIC_SUBS);
  const sub0 = seq.publicSubaccounts()[0]!; // = the first LIVE card (both derive from live.wallets order)

  // Flip sub0's reported open orders to 2, then a fill for sub0 drives a TARGETED reconcile that
  // reads -> maps -> renders the new count. (Proves the read->map->UI half, not just the request.)
  orders.set(sub0.toLowerCase(), 2);
  seq.emitFill(sub0);

  const firstLiveCard = page.getByTestId("wallet-card").first();
  await expect(firstLiveCard.getByText("2 orders")).toBeVisible({ timeout: 6_000 });

  // Opening the drawer surfaces the reconciled open-orders LIST (Wave 1), not just the count.
  await firstLiveCard.click();
  await expect(page.getByText("Open orders (2)")).toBeVisible({ timeout: 5_000 });

  // Wave 1b: the selected market's order book renders in the drawer, with the X18 size -> human
  // mapping intact (mock bid 995 / ask 1005 from getMarketLiquidity).
  await expect(page.getByText(/Order book ·/)).toBeVisible({ timeout: 6_000 });
  await expect(page.getByText("995")).toBeVisible();
});

test("ws-routing-flow: every cohort subaccount is read; an unknown-subaccount fill is ingested but never read", async ({ page }) => {
  const reads = new Set<string>();
  const seq = new MockSequencer();
  await seq.install(page);
  await mockState(page);
  await mockRelay(page, { onQuery: (q) => { const s = querySubaccount(q); if (s) reads.add(s); } });
  await mockNativeRpc(page);

  await page.goto("/");
  await unlockGeneratedCohort(page);
  await expect.poll(() => seq.subscribes.length, { timeout: 15_000 }).toBe(PUBLIC_SUBS);
  const cohort = seq.publicSubaccounts().map((s) => s.toLowerCase());

  // Positive: every cohort subaccount gets a read REQUEST (reconcile reads are wired to the real
  // in-tab identities — the sweep + targeted reconciles cover all of them).
  await expect.poll(() => cohort.every((s) => reads.has(s)), { timeout: 12_000 }).toBe(true);

  // Guard: a known fill is read; an unknown-subaccount fill is ingested (counted) but maps to no
  // cohort wallet, so it triggers NO reconcile — and it is never swept either. Anchor the negative
  // on a positive post-emit signal (a fresh read of the known subaccount) rather than a blind wait.
  reads.clear();
  seq.emitFill(cohort[0]!);
  seq.emitFill(UNKNOWN_SUBACCOUNT);
  await expect(page.getByText(/· 2 events/)).toBeVisible({ timeout: 5_000 }); // both frames ingested
  await expect.poll(() => reads.has(cohort[0]!), { timeout: 5_000 }).toBe(true); // a read cycle passed after the emits

  expect(reads.has(UNKNOWN_SUBACCOUNT.toLowerCase()), "unknown subaccount must never be read").toBe(false);
});

test("ws-readiness-flow: readiness is COMPUTED (collateral gate), not hardcoded; native gas reads & renders", async ({ page }) => {
  const nativeOwners = new Set<string>();
  const seq = new MockSequencer();
  await seq.install(page);
  await mockState(page);
  await mockRelay(page); // mock reports ZERO quote collateral for every subaccount
  // Every cohort EOA reports 0.001 ETH gas — well above the 0.00003 floor. With collateral still 0,
  // the quote-GATE must keep each card `unfunded`: this fails for the OLD hardcoded "ready" AND for a
  // (wrong) gas-only readiness, so it pins the compute wiring, not just the happy path.
  await mockNativeRpc(page, { defaultWei: 1_000_000_000_000_000n, onCall: (o) => nativeOwners.add(o) });

  await page.goto("/");
  await unlockGeneratedCohort(page);
  await expect.poll(() => seq.subscribes.length, { timeout: 15_000 }).toBe(PUBLIC_SUBS);

  const firstLiveCard = page.getByTestId("wallet-card").first();
  // native read -> VM -> DOM: the mocked gas renders on the card. The read is stale-while-revalidate
  // (never blocks the critical reconcile), so the value lands on a FOLLOWING round-robin sweep pass,
  // not the first — poll generously (Playwright resolves the instant it appears).
  await expect(firstLiveCard.getByText(/0\.001 ETH/)).toBeVisible({ timeout: 20_000 });
  // ...and despite gas >= floor, zero collateral keeps readiness `unfunded` (the compute, end-to-end).
  await expect(firstLiveCard.getByText(/^unfunded$/)).toBeVisible();
  // the keyless native-gas read path actually fired for the cohort.
  expect(nativeOwners.size).toBeGreaterThan(0);
});
