// =============================================================================
// Drawer layout stability: async content that lands after the live drawer opens must not move the
// controls below it. The order book arrives ~200ms after open (debounce + metered relay read) — the
// moment an operator (or a test) is already clicking Funding / Gas refuel. When its section popped
// in above those controls, a press that straddled the insert lost its click: pointerdown hit the
// button, pointerup landed on whatever had moved under the pointer, so `click` went to their common
// ancestor and the confirm never opened (the refuel-cap e2e failure). This holds the book reply and
// releases it BETWEEN pointerdown and pointerup — the exact interleaving, made deterministic.
// Real in-tab wative crypto + IndexedDB; the sequencer/RPC are mocked for determinism.
// =============================================================================
import { test, expect } from "@playwright/test";
import { mockState, mockRelay, mockNativeRpc, MockSequencer, unlockGeneratedCohort } from "../_helpers/mock-live";

const PUBLIC_SUBS = 3 * 2; // 3 generated subaccounts × {fill, position_change}
const ONE_ETH = 1_000_000_000_000_000_000n;

test("drawer-stable-layout-flow: the order book landing mid-press neither moves Gas refuel nor eats its click", async ({ page }) => {
  let releaseBook!: () => void;
  const bookGate = new Promise<void>((r) => { releaseBook = r; });
  const seq = new MockSequencer();
  await seq.install(page);
  await mockState(page);
  await mockRelay(page, { bookGate });
  await mockNativeRpc(page, { defaultWei: ONE_ETH });

  await page.goto("/");
  await unlockGeneratedCohort(page);
  await expect.poll(() => seq.subscribes.length, { timeout: 15_000 }).toBe(PUBLIC_SUBS);

  await page.getByTestId("wallet-card").nth(1).click(); // non-treasury → the Gas refuel control is present
  await expect(page.getByText(/Live stream \(WS\)/)).toBeVisible();
  // The book read is held, yet its fixed-height slot is already mounted (no levels drawn yet).
  await expect(page.getByText(/^Order book ·/)).toBeVisible();
  await expect(page.getByText("1005")).toHaveCount(0);

  const refuel = page.getByRole("button", { name: "Refuel gas" });
  await refuel.scrollIntoViewIfNeeded();
  const before = (await refuel.boundingBox())!;
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  releaseBook(); // the book lands while the button is still pressed…
  await expect(page.getByText("1005")).toBeVisible();
  expect((await refuel.boundingBox())!.y).toBe(before.y); // …and nothing above the button moved
  await page.mouse.up();

  // The press + release both hit the button, so the click reached it and the typed confirm opened.
  await expect(page.getByLabel(/to confirm/i)).toBeVisible();
});
