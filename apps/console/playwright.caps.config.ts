// =============================================================================
// Playwright config for the SPEND-CAP rejection gate (tests/caps). Separate from the main
// config because it boots a dev server with DELIBERATELY LOW caps baked in via NEXT_PUBLIC_*
// env, so tiny, obvious inputs trip every cap — proving the guards actually FIRE (the main
// suite proves they don't BREAK normal flows; this one proves they reject).
//
// Own port (18271) + reuseExistingServer:false so it ALWAYS launches a fresh server with the
// low-cap env — it never reuses the default-cap dev server on 18270 (which would make every
// assertion silently pass-through). The main config testIgnores tests/caps so it never runs
// these specs against default caps (where the inputs here are under the ceiling).
// =============================================================================
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(os.homedir(), ".claude", "toolchains", "Playwright", "browsers");

const PORT = process.env.CAPS_PORT ?? "18271";
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/caps",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
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
  // Always launch a FRESH low-cap server (never reuse 18270's default-cap one). The low caps
  // are build-time-inlined into the client bundle via these NEXT_PUBLIC_* vars at dev start.
  // MAX_REFUEL_ETH stays >= the default refuel amount (0.0001) so a normal refuel wouldn't
  // fail; the test trips it with a larger amount.
  webServer: {
    command: `./node_modules/.bin/next dev -H 127.0.0.1 -p ${PORT}`,
    url: BASE,
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      NEXT_PUBLIC_NADO_MAX_ORDER_NOTIONAL_USDT0: "10",
      NEXT_PUBLIC_NADO_MAX_DEPOSIT_USDT0: "10",
      NEXT_PUBLIC_NADO_MAX_REFUEL_ETH: "0.001",
      NEXT_PUBLIC_NADO_MAX_COHORT_USDT0: "15",
    },
  },
});
