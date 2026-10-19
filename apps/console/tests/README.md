# Console monkey-test runner (Playwright)

Browser-level Flows for the **live WS subscribe → route → per-wallet reconcile → UI** path
(the scaling epic's read-decoupling, W1–W6). Previously only statically audited; these drive the
**real shipped path** headless.

## Run

```bash
pnpm --filter console test:e2e
```

Reuses the shared global Playwright toolchain's browser store (pinned Chromium 1228) via
`PLAYWRIGHT_BROWSERS_PATH` — set automatically in `playwright.config.ts` from `os.homedir()`, so
there is **no per-repo Chromium download** and nothing to `playwright install`. Locally it reuses a
dev server already on `:18270` (and self-starts one otherwise).

> **CI is a follow-up, not wired yet.** The "adopt, don't re-install" / shared-store setup is
> **local-only** — the store holds a darwin-arm64 build that won't exist on a clean Linux runner,
> and the suite is not in `ci.yml` (nor in any `test` script, so `pnpm -r test` skips it). A CI e2e
> job must: override `PLAYWRIGHT_BROWSERS_PATH` to a CI cache, `playwright install --with-deps
> chromium` (the no-install rule is a local exception), and run the webServer as a **production
> build** (`next build` + `next start`) so there is no request-time dev compilation during tests.
> The config's `CI` branches (`forbidOnly`/`retries`/`reuseExistingServer`) are already in place for
> that job.

## How it stays deterministic & offline

- **Real in-tab custody**: each Flow unlocks a fresh `N=3` cohort through the real `CustodyPanel`
  UI (`Generate … in-tab` → wative-core browser crypto + IndexedDB). No test seam is added to the
  key-handling code. Launch-mode ephemeral contexts isolate the `nado-ika-custody` IndexedDB per
  test, so `generate` always starts clean.
- **Pure-mock sequencer** (no real testnet, no funded cohort): `tests/_helpers/mock-live.ts`
  - `page.route('**/api/nado/state')` → canned `LiveConfig` with a **test-owned** `wss://` URL,
  - `page.routeWebSocket(…)` → a pure mock that learns each cohort subaccount from the client's own
    `subscribe` frames and pushes synthetic `fill` / `position_change` frames on demand,
  - `page.route('**/api/nado/relay/**')` → valid-empty engine envelopes (shapes verified against
    `@nadohq/engine-client` query mappers) so reconciles complete cleanly.

## Named Flows (`tests/scaling/ws-reconcile.spec.ts`)

| Flow | Proves |
|---|---|
| `ws-subscribe-flow` | cohort unlock → `WS live`, and **both** public streams (`fill` + `position_change`, the W3 change) subscribed for every cohort subaccount over the one socket |
| `ws-ingest-flow` | `fill` + `position_change` frames increment the sweep-independent `N events` header counter and render in the wallet drawer |
| `ws-routing-flow` | every cohort subaccount is reconciled; a **non-cohort** subaccount's fill is ingested but **never read** (the subaccount→wallet routing guard) |

## Known limits (follow-ups)

- The read-**amount** scaling property (O(active) not O(cohort)) is not asserted here — the
  budget-paced sweep reads every cohort wallet continuously, so it belongs in a unit-level test of
  the page effect (spy on `reconcileWallet`).
- Reconcile→UI **data**-change assertions (card order count / balance flipping) need non-empty engine
  envelopes (valid `appendix` via `@nadohq/shared`); deferred — the current Flows prove the wiring,
  ingestion, and routing with valid-empty reads.
