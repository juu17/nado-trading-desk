# Mainnet capacity run — real-funds safety design

**Status:** PLAN — not yet authorized to place live orders. This document is the decision-#7
real-funds safety pass. It is gated behind two explicit go/no-go points (below). Testnet work is
complete and banked; this is the first time the harness touches real funds.

**North-star:** measure Nado's matching-engine capacity (matched fills/sec + p50/p99 fill-confirm
latency) where an A↔B self-cross can actually fire — which the testnet venue ceiling prevented.

---

## 0. Why mainnet (the reframe) — and why it is NOT risk-free

A deeper book does **not** auto-fix the self-cross; it changes the problem:

- Testnet's failure was **maker-rejection**: a thin, volatile spread meant A's post-only maker at
  best±tick crossed by submit time ~98% of the time, so it rarely rested to be crossed.
- Mainnet's stable spread fixes that — A's maker **rests reliably**.
- But a deep book is full of external MM liquidity, so a top-of-book cross still competes with
  strangers. The mechanism that works is: **A improves the touch** (rests strictly inside the
  spread, 1 tick better than the near touch), then **B crosses at A's exact price** — price-time
  priority matches the best price first, which is A.
- A's improving maker is exposed to external takers for the round-trip window (~150–400 ms) — a real
  risk of a fill against a stranger → a real open position and real P&L. Posting at a **fresh,
  strictly-better tick that is empty of external orders** (A alone at its price) removes the
  same-price queue risk, so what remains is only this **timing-window race**, bounded below
  (cancel-on-timeout + tiny notional + the global stop). Not the same-tick queue problem that sank
  the testnet run — but not zero either.

---

## 1. Locked decisions (interview, 2026-10-30)

| # | Decision | Locked value |
|---|---|---|
| 1 | Risk ceiling | **Minimal probe**: ~$100 total funded; auto-halt+flatten at **~$25 net loss**; smallest per-order notional the market allows. |
| 2 | Market | **Auto-pick a stable mid-spread market** via a live book scan (mainnet criteria: spread reliably ≥2–3 ticks, stable, thin top-of-book). No symbol pinned in advance. |
| 3 | Stray fills | **Flatten-and-continue**: each stray → immediate reduce-only IOC flatten + log; circuit-breaker pauses if strays get frequent/expensive; the $25 global stop is the hard backstop. |
| 4 | Probe shape | **N=1**, read-only dry-run + 3-round canary first, short **~90 s** window, then stop-and-report. The ramp to higher N is a separate decision after this result. |

---

## 2. Mechanism

- **Open.** A posts a post-only maker at a **fresh, strictly-better tick that is empty of external
  orders** (1 tick better than the near touch, with headroom from the opposite touch so it survives a
  small tighten) — so A is the *sole* order at its price. On a stable book it rests. The instant A's
  maker is confirmed resting-and-best, B sends an **IOC hard-limited to exactly A's price** (BUY if A
  is the ask, SELL if A is the bid): price-time priority routes B to the sole order at that price (A),
  and the hard limit means B **cannot sweep past A into external liquidity**. This realizes the
  testnet session's flagged "bind B to A's resting digest" idea as pricing+sequencing discipline,
  rather than a (non-existent) engine named-match feature. If no empty strictly-better tick is
  available (spread too tight), the round is skipped rather than placed into an occupied level.
- **Close.** Mirror: B posts a reduce-only maker improving the touch, A crosses reduce-only IOC →
  the pair returns flat.
- **Fill source / terminality** — unchanged from the validated testnet path: resting-maker fill from
  `getSubaccountMultiProductOrders`, taker fill from the keyless public `fill` WS stream, terminality
  by position reconciliation (`getSubaccountSummary`), never a missing-cancel row.

---

## 3. Real-funds guardrails (the build scope)

Everything below is **new code or newly-wired** for mainnet. It is built and tested offline/on
testnet (no funds) before any mainnet order.

1. **Ledger HALTED by default.** `OrderLedger` already starts HALTED (`TRADING_STOPPED`,
   `order-ledger.ts:111`); it is `.enable()`-d only after the dry-run + canary gate, never at
   assembly.
2. **Real per-wallet equity + maxLoss enforcement.** Replace the benchmark path's
   `PLACEHOLDER_EQUITY_X18` (`experiment-connector.ts:334-337`) with real equity from `getBalances`
   (sum USDT0 collateral) and enforce the per-wallet `maxLossPerWalletX18` cap that validation
   already models. This closes the one place the self-cross path ignored risk.
3. **Global net-loss stop (the $25).** Each tick, compute cohort equity drop = `(funded baseline −
   current total USDT0 collateral, marked to market)`. At N=1 the pair is hedged so net position
   ≈ 0 and the drop is realized cost (fees + any spread paid). If the drop ≥ the configured stop →
   `coordinator.halt()` + `requestExit` (flatten) + ledger stays disabled. Checked every tick
   (sub-second at TURBO).
4. **Stray-fill detect → reduce-only flatten → continue.** A stray = A's maker filled by a stranger,
   or B sweeping external liquidity before reaching A (A filled 0). Detect per round from the fill
   evidence; fire an immediate reduce-only IOC to flatten the stray; log it. **Today this degrades to
   `UNKNOWN` → run-terminating** — so this is net-new control flow that turns the default "pause on
   stray" into the chosen "flatten-and-continue," with a **circuit-breaker**: pause the run if strays
   exceed a count cap OR their cumulative cost exceeds half the global stop.
5. **Cancel-on-timeout.** A's resting maker is cancelled if B has not crossed it within a short
   timeout (≈ 2× expected round-trip), bounding the stranger-exposure window on every round.
6. **Min-notional sizing.** Per-order notional = the market's live `minSize` (read at dry-run), not
   the hardcoded `100e18`. Smallest allowed order = smallest stray exposure.

---

## 4. Execution phases (and the two authorization gates)

- **Phase M0 — build (no funds).** Implement §3 on a branch; prove green offline + the existing
  testnet-gated runners still pass. **← GATE 1: you approve this plan + design before M0 starts.**
- **Phase M1 — read-only dry-run (mainnet, no funds, no keys-in-play).** Run a mainnet preflight
  (reachability, chainId 57073, market count) + the book scan to confirm a workable stable
  mid-spread market exists, and read the venue's real **fee schedule, min-notional, and IMF** to
  size funding and sanity-check the $25 stop. Produces the exact funding figure.
- **Phase M2 — fund (you, real money).** You fund the mainnet custody wallets with the dry-run's
  figure (gas ETH + USDT0 collateral). Keys are generated into / live in an encrypted custody
  workspace; **keys are never pasted in chat and I never see them** (same custody model as testnet).
- **Phase M3 — canary + window.** **← GATE 2: explicit live go.** Enable the ledger; place the first
  ~3 rounds; auto-pause; I surface flat-state + A↔B-cross-rate + realized cost for your eyeball;
  on your release, run the ~90 s N=1 window; then stop, flatten, prove flat+settled, report.

No mainnet order is placed before GATE 2.

---

## 5. Abort conditions (auto-halt + flatten)

- Cohort equity drop ≥ the global stop (~$25).
- Stray count or cumulative stray cost over the circuit-breaker caps.
- Any genuine `UNKNOWN` (maybe-placed) / fatal reject — the existing run-terminating gate is kept
  for these real cases (only *classified* refusals resolve locally).
- A per-wallet `maxLoss` breach.
- Market goes unpriceable / `TRADING_STOPPED` mid-run.

On any abort: `requestExit` → close open rounds reduce-only → `assertCohortFlatSettled` → report.

---

## 6. Key handling

Signing keys live in an encrypted wative/custody workspace (`Custody.open({ path, password })`),
referenced by a mainnet credentials file (e.g. `~/.nado-ika-mainnet/credentials.json`) that carries
the workspace path + password — set up out-of-band by the operator. Keys are never in source, never
in chat, never logged. The engine client is keyless; only the custody signer signs.

---

## 7. Confirmed at dry-run (not assumed here)

- Nado mainnet **fee schedule** (taker fee / maker rebate) — refines the cost-per-round and the $25
  headroom. Structural estimate: at a few bps on ~$100 notional, a clean round costs cents and a
  stray a fraction of a dollar, so $25 absorbs the full ~90 s N=1 window many times over — to be
  confirmed, not assumed.
- Real mainnet **min-notional** and **IMF** per the chosen market — sets per-order size and the exact
  funding figure.
- That a **stable mid-spread market** actually exists on mainnet at run time (the book scan proves it
  before any order; if none appears, the run does not start).
