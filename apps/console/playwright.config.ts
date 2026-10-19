// =============================================================================
// Playwright config for the console monkey-test runner — the sandwich-harness Verify
// gate for the live WS subscribe -> route -> per-wallet reconcile -> UI path (the scaling
// epic's read-decoupling), which was previously only statically audited.
//
// Toolchain adoption (per the global Playwright toolchain rule): this reuses the ONE shared
// pinned browser store (Chromium 1228, @playwright/test 1.61.1 EXACT) instead of a per-repo
// download — we point PLAYWRIGHT_BROWSERS_PATH at the shared store (derived from os.homedir()
// at runtime, never a hardcoded local path) and never run `playwright install`.
//
// Determinism: LAUNCH mode (ephemeral context per test) so the in-tab custody IndexedDB
// ('nado-ika-custody') starts clean every test — no shared-profile leak. The sequencer is
// fully mocked at the browser edge (page.route for /state + /relay, page.routeWebSocket for
// the public stream), so the run needs no real testnet and no funded cohort.
// =============================================================================
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Reuse the shared global Playwright browser store — no per-repo Chromium.
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(os.homedir(), ".claude", "toolchains", "Playwright", "browsers");

const PORT = process.env.PORT ?? "18270";
const BASE = process.env.PW_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests",
  // tests/caps runs under playwright.caps.config.ts with a low-cap server; skip it here so the
  // cap-rejection specs never run against this suite's default (high) caps.
  testIgnore: "caps/**",
  // Custody persists in IndexedDB per context; keep the suite serial + single-worker so
  // each ephemeral-context test is independent and the reconcile timing is stable.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0, // 0 locally so flake is felt, not hidden
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE,
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1440, height: 900 },
    contextOptions: { reducedMotion: "reduce" },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Self-launch the app in CI; locally reuse the already-running dev server on :18270.
  // /api/nado/state is browser-mocked, so the server's NADO_LIVE branch is irrelevant here.
  webServer: {
    command: `./node_modules/.bin/next dev -H 127.0.0.1 -p ${PORT}`,
    url: BASE,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
