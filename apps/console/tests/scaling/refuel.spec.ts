// =============================================================================
// Wave 3b: operator-triggered GAS REFUEL — native ETH sent from the in-tab TREASURY (live:0) to a
// recipient wallet, signed by the treasury's SEALED key in-tab and broadcast by a keyless ChainClient.
// These Flows drive the REAL shipped path in a browser: real in-tab custody (wative-core + IndexedDB)
// unlocks a cohort, the drawer's Refuel action calls refuelGasLive, and mockInkRpc mocks the Ink JSON-RPC
// (balance + autofill + broadcast) so the full build→sign→broadcast→receipt runs offline + deterministic.
// Keyless SIGNING is real (in-tab crypto needs no network); only the RPC reads/submit are mocked.
// =============================================================================
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { parseTransaction, parseEther, parseUnits, decodeFunctionData } from "viem";
import { mockState, mockRelay, mockInkRpc, MockSequencer, unlockGeneratedCohort } from "../_helpers/mock-live";

const PUBLIC_SUBS = 3 * 2; // 3 generated subaccounts × {fill, position_change}
const ONE_ETH = 1_000_000_000_000_000_000n;
const USDT0 = "0x60F50F902b2E91aef7D6c700Eb22599e297fa86F".toLowerCase(); // Ink-testnet faucet token
const MINT_ABI = [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] as const;

/** Open the Nth LIVE wallet card's drawer (0 = live:0 = the treasury). */
async function openLiveDrawer(page: Page, n: number) {
  const card = page.getByTestId("wallet-card").nth(n);
  await card.click();
  await expect(page.getByText(/Live stream \(WS\)/)).toBeVisible();
}

/** The open drawer's FULL wallet address (the header now renders it untruncated), lowercased, so a
 *  decoded tx's `to` can be matched exactly to THIS wallet. Scoped to the drawer <aside>; the locked
 *  sidebar list only shows truncated "0x…" so it can't match the full-length pattern. */
async function drawerAddress(page: Page): Promise<string> {
  const el = page.locator("aside").getByText(/^0x[0-9a-fA-F]{40}$/).first();
  return ((await el.textContent()) ?? "").trim().toLowerCase();
}

test("refuel-guard-flow: the treasury wallet (live:0) shows the treasury note and NO refuel control", async ({ page }) => {
  const seq = new MockSequencer();
  await seq.install(page);
  await mockState(page);
  await mockRelay(page);
  await mockInkRpc(page, { defaultWei: ONE_ETH });

  await page.goto("/");
  await unlockGeneratedCohort(page);
  await expect.poll(() => seq.subscribes.length, { timeout: 15_000 }).toBe(PUBLIC_SUBS);

  await openLiveDrawer(page, 0); // the FIRST live card = live:0 = the treasury
  // The treasury is the gas SOURCE: it funds others and must not refuel itself.
  await expect(page.getByText(/This is the gas .*treasury/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Refuel gas" })).toHaveCount(0);
});

test("refuel-insufficient-flow: a dry treasury surfaces a clear error, never an opaque broadcast failure", async ({ page }) => {
  const methods: string[] = [];
  const seq = new MockSequencer();
  await seq.install(page);
  await mockState(page);
  await mockRelay(page);
  await mockInkRpc(page, { defaultWei: 0n, onCall: (m) => methods.push(m) }); // treasury reports ZERO gas → precheck must refuse

  await page.goto("/");
  await unlockGeneratedCohort(page);
  await expect.poll(() => seq.subscribes.length, { timeout: 15_000 }).toBe(PUBLIC_SUBS);

  await openLiveDrawer(page, 1); // a NON-treasury wallet (live:1) → the refuel control is present
  await page.getByRole("button", { name: "Refuel gas" }).click();
  await page.getByLabel(/to confirm/i).fill("RUN");
  await page.locator("button", { hasText: "Confirm & run" }).click();

  // The up-front treasury solvency precheck fails fast with an operator-facing error...
  await expect(page.getByText(/✗ refuel 0\.0001 ETH — treasury is low on gas/)).toBeVisible({ timeout: 10_000 });
  // ...and crucially NO raw tx was ever broadcast on the dry-treasury path (no value left the treasury).
  expect(methods).not.toContain("eth_sendRawTransaction");
});

test("refuel-happy-flow: a funded treasury signs + broadcasts the CORRECT native send and logs success", async ({ page }) => {
  const methods: string[] = [];
  let rawTx: string | undefined;
  const seq = new MockSequencer();
  await seq.install(page);
  await mockState(page);
  await mockRelay(page);
  // Every wallet (incl. the treasury) reports 1 ETH → the precheck passes; the broadcast + receipt are
  // canned to a success so the full in-tab sign → keyless broadcast → receipt path completes. Capture the
  // raw signed bytes so the test can decode + assert WHAT was actually sent (not just that a send fired).
  await mockInkRpc(page, {
    defaultWei: ONE_ETH,
    onCall: (m, p) => { methods.push(m); if (m === "eth_sendRawTransaction") rawTx = String(p[0]); },
  });

  await page.goto("/");
  await unlockGeneratedCohort(page);
  await expect.poll(() => seq.subscribes.length, { timeout: 15_000 }).toBe(PUBLIC_SUBS);

  await openLiveDrawer(page, 1); // refuel a NON-treasury wallet from the treasury
  const recip = await drawerAddress(page); // this wallet's (recipient) full address
  await page.getByRole("button", { name: "Refuel gas" }).click();
  await page.getByLabel(/to confirm/i).fill("RUN");
  await page.locator("button", { hasText: "Confirm & run" }).click();

  // The full build→sign→broadcast→receipt path completed (real in-tab signing, mocked RPC).
  await expect(page.getByText(/✓ refuel 0\.0001 ETH → this wallet/)).toBeVisible({ timeout: 15_000 });
  expect(methods).toContain("eth_sendRawTransaction");

  // Decode the REAL signed tx and assert its CONTENTS — this is the first wave to move value on-chain, so
  // the suite must catch a wrong amount (e.g. 6-dp USDT scaling), wrong chain, or wrong recipient.
  expect(rawTx).toBeTruthy();
  const tx = parseTransaction(rawTx as `0x${string}`);
  expect(tx.value).toBe(parseEther("0.0001")); // 18-dp ETH, NOT the 6-dp parseUnits used for USDT0
  expect(tx.chainId).toBe(763373);             // Ink testnet
  const to = String(tx.to).toLowerCase();
  expect(to).toBe(recip); // → the recipient, not the treasury
});

test("mint-flow: the treasury mints the CORRECT USDT0 amount to a wallet and logs success", async ({ page }) => {
  let rawTx: string | undefined;
  const seq = new MockSequencer();
  await seq.install(page);
  await mockState(page);
  await mockRelay(page);
  // Treasury has gas (mint pays gas, value=0) → the gas precheck passes; broadcast + receipt canned to
  // success. Capture the raw tx to decode the mint calldata (6-dp amount + recipient).
  await mockInkRpc(page, { defaultWei: ONE_ETH, onCall: (m, p) => { if (m === "eth_sendRawTransaction") rawTx = String(p[0]); } });

  await page.goto("/");
  await unlockGeneratedCohort(page);
  await expect.poll(() => seq.subscribes.length, { timeout: 15_000 }).toBe(PUBLIC_SUBS);

  await openLiveDrawer(page, 1); // mint TO live:1 FROM the treasury (live:0)
  const recip = await drawerAddress(page);
  await page.getByRole("button", { name: /^Mint / }).click(); // "Mint 100"
  await page.getByLabel(/to confirm/i).fill("RUN");
  await page.locator("button", { hasText: "Confirm & run" }).click();

  await expect(page.getByText(/✓ mint 100 USDT0 → this wallet/)).toBeVisible({ timeout: 15_000 });

  // Decode the signed tx: it is a USDT0.mint(recipient, 100 * 1e6) call on the Ink testnet — proves the
  // 6-dp scaling (not 18), the right token, and the right recipient.
  expect(rawTx).toBeTruthy();
  const tx = parseTransaction(rawTx as `0x${string}`);
  expect(String(tx.to).toLowerCase()).toBe(USDT0);       // the USDT0 contract, not a bare transfer
  expect(tx.chainId).toBe(763373);
  const decoded = decodeFunctionData({ abi: MINT_ABI, data: tx.data as `0x${string}` });
  expect(decoded.functionName).toBe("mint");
  expect(decoded.args[1]).toBe(parseUnits("100", 6));     // 6-dp USDT0, NOT parseEther/18
  const mintTo = String(decoded.args[0]).toLowerCase();
  expect(mintTo).toBe(recip); // minted to live:1
});

test("fund-cohort-flow: bulk-funds every UNFUNDED live wallet (skips the treasury) with correct amounts", async ({ page }) => {
  const sendRaws: string[] = [];
  const seq = new MockSequencer();
  await seq.install(page);
  await mockState(page);
  await mockRelay(page); // empty subaccount summaries → every wallet reads as readiness `unfunded`
  // All wallets report 1 ETH → the per-wallet gas step is SKIPPED (idempotent), so the flow exercises
  // mint + approve + deposit. eth_call (balanceOf/allowance) returns 0x → 0, so mint + approve both fire.
  await mockInkRpc(page, { defaultWei: ONE_ETH, onCall: (m, p) => { if (m === "eth_sendRawTransaction") sendRaws.push(String(p[0])); } });

  await page.goto("/");
  await unlockGeneratedCohort(page); // 3 in-tab wallets: live:0 (treasury) + live:1 + live:2
  await expect.poll(() => seq.subscribes.length, { timeout: 15_000 }).toBe(PUBLIC_SUBS);

  // The FundingPanel targets unfunded live wallets EXCEPT the treasury → 2 (live:1, live:2).
  const fundBtn = page.getByRole("button", { name: /^Fund 2 wallets$/ });
  await expect(fundBtn).toBeVisible({ timeout: 15_000 });
  await fundBtn.click();
  await page.getByLabel(/to confirm/i).fill("RUN");
  await page.locator("button", { hasText: "Confirm & run" }).click();

  // Both targets funded, none failed. (The panel excludes the treasury up front, so the orchestrator's
  // own treasury-skip guard — defense-in-depth for programmatic callers — isn't exercised → skipped 0.)
  await expect(page.getByText(/funded 2, failed 0, skipped 0/)).toBeVisible({ timeout: 30_000 });

  // Decode the broadcasts: exactly TWO USDT0.mint calls (one per target), each for the 6-dp deposit-
  // enabling amount — proves per-wallet iteration + correct scaling (not 18-dp), not a single call.
  const mintAmts = sendRaws.map((r) => {
    try {
      const tx = parseTransaction(r as `0x${string}`);
      if (String(tx.to).toLowerCase() !== USDT0) return undefined;
      const d = decodeFunctionData({ abi: MINT_ABI, data: tx.data as `0x${string}` });
      return d.functionName === "mint" ? (d.args[1] as bigint) : undefined;
    } catch { return undefined; }
  }).filter((x): x is bigint => x !== undefined);
  expect(mintAmts.length).toBe(2);
  for (const amt of mintAmts) expect(amt).toBe(parseUnits("100", 6));
});
