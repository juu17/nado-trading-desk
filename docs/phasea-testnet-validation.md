# Phase A — testnet validation checklist (operator step)

The offline Phase-A work (experiment A/B FSM, max-throughput mode, self-cross open/close,
`@farm/loadgen` idempotency + dispatch classification + cohort settle gate, and the
fake-gateway `ExperimentConnector` skeleton) is unit-tested with mocks only. Static/mocked
gates are **necessary but not sufficient** for the live order path: the items below MUST be
confirmed against the real Nado sequencer on **testnet** before any capacity number is
trusted, and before the connector's live wiring is relied on.

**Testnet only.** Mainnet stays gated behind explicit user authorization (decision #7).
Untrusted code never touches real funds; the cohort is pre-funded out of band (seed script).

## ✅ LIVE VALIDATION RESULT — PASS (Ink testnet, 2026-10-30)
One N=1 A/B self-cross open+close ran live via `packages/loadgen/src/testnet-ab-round.test.ts`
(`NADO_LIVE=1`), on **BTC-PERP** (the deterministic cross needs a >=2-tick spread; empty-book
markets turned out to be trading-BLOCKED, code 2069). A = `0x01b3…D9d1`, B = `0x0451…02dA`.
All 6 sections below passed. Key outcomes:
- **Self-cross (open):** A post-only maker rested at bid+tick (77608, the unique top-of-book bid);
  B's IOC SELL at 77608 crossed **only A**. Both legs filled **0.0013 BTC** at quote **100.8904
  USDT0** (identical), A paid the **maker** fee 0.01009, B the **taker** fee 0.03531 (rates
  0.0001 / 0.00035 — exact). Close mirrored (B reduce maker, A IOC) and net-zeroed to baseline.
- **Fill-confirm latency:** ~183 ms (open), ~181 ms (close) — fills seen on the keyless WS.
- **A-5 authoritative fill source:** confirmed both legs TERMINAL with correct base/quote/fee from
  engine `getOrder` (maker) + the summed keyless `fill` stream, reconciled against a fresh
  position (polled past the ~sub-second position lag behind the fill stream).
- **Codes confirmed + folded into `classify.ts`:** 2008 post-only-would-cross, 2069
  trading-blocked, 2020 order-not-found (all were previously unmapped → unknown→halt).
- **§4 STP:** A and B are distinct per-wallet subaccounts; the intended A↔B cross filled on BOTH
  open and close with **no operator/group STP cancelling it** → B-2 stays a Phase-B policy for
  *unintended* cross-pair only.
- **Raw `fill` frame (pinned):** `{ type:"fill", product_id, subaccount, order_digest,
  filled_qty, remaining_qty, original_qty, price, is_taker, is_bid, fee, submission_idx }` — all
  numeric fields X18 (e.g. price 77608e18); both subaccounts receive a frame per match sharing a
  `submission_idx`. Matches the `FillAccumulator` mapping.
- **Caveat:** the cohort wallets carry pre-existing inventory from earlier testing, so the round
  was measured by **delta-to-baseline** (A +0.0013 then back; B −0.0013 then back) and the
  absolute cohort flat-gate was n/a; on a genuinely flat-start cohort it runs the absolute gate.
  A deterministic cross depends on catching a >=2-tick spread (live MM books are mostly 1-tick);
  the runner polls for one. NO capacity ramp was run.

## 1. Dispatch classification code table (`@farm/loadgen` `classify.ts`)
The `classifyDispatch` policy maps sequencer/transport outcomes to deduped / not-sent /
refused / rejected-fatal / unknown.

**As built** — the raw→`DispatchErrorInfo` normaliser (`experiment-connector.ts`
`defaultNormaliseError`) now reads the two concrete shapes the live stack throws: the sequencer
refusal `AdapterError` (code at `raw.error_code`, which the skeleton missed → everything fell to
`unknown`→halt) and the transport `httpError` (HTTP status at `raw.status`; any edge **403 →
not-sent**). A code-tagged token is mined from free text ONLY for non-network errors (a relay-5xx
body's "code: 2013" must not fabricate a phantom dedup); a numeric-string `code` is a 4-digit
venue code or a 3-digit HTTP status by magnitude. The pure policy below is unchanged; the code
SETS still must be confirmed against the LIVE sequencer:
- [ ] **2013 DIGEST_ALREADY_EXISTS** → a byte-identical retry is absorbed as **placed** (the
      no-double-place guarantee). Confirm resubmitting the identical signed order returns 2013
      (not a second placement), and that `classify` → `deduped` leads to the existing order being
      treated as live.
- [ ] **Refusal codes** actually returned for: post-only-would-cross, IOC-no-cross, margin/health
      (2006/2036/2092), min-size (2003/2094), price-band (2007), late-recv (2011), expiry (2004),
      address-screening (2023), reduce-only-not-applicable (2067). Confirm each is a per-order
      refusal (round re-prices), NOT a fatal halt.
- [ ] **Fatal codes** (malformed / mis-signed / bad appendix 2095) → stop-all. Confirm the real
      malformed-request code(s) and that they are the ONLY ones mapped fatal.
- [ ] **Rate limit** (1000/1015, HTTP 429) → not-sent (the exchange shed it). Confirm.
- [ ] **Cloudflare WAF 403 "Invalid compression headers"** → not-sent (request blocked before the
      sequencer; see the accept-encoding note). Confirm `--compressed`/undici path and that a 403
      here is `not-sent`, never `unknown`.
- [ ] Any UNRECOGNISED sequencer code stays `unknown` (maybe-placed, query first). Confirm no live
      code that means "didn't place" is being silently mapped to `unknown` (would under-count: a
      sub-saturation transient must be `not-sent`, per seams contract #3).

## 2. Authoritative per-order fill source (A-5 — IOC finality by position reconciliation)
The coordinator's `ExperimentConnector.lookup` must return each order's TRUE cumulative fill,
especially for the taker (B on open, A on close) that never rests.

**As built (query/position-authoritative; the `fill` stream is the WAKE transport + per-fill
feed, NOT the sole source of truth)** — `packages/loadgen/src/live-order-fill.ts`
`createLiveOrderFillSource` over `packages/adapter-nado/src/fill-source.ts`:
- **Resting maker** → engine `getOrder({productId,digest})` raw X18 `totalAmount`/`unfilledAmount`
  (filled = |total|−|unfilled|); `resting` while `unfilled>0`.
- **Taker (IOC) / fills** → the keyless **public `fill` stream** summed by digest in a pure
  `FillAccumulator` with unit-correct math: base from the (original−remaining) progression,
  `quoteX18 = Σ Δbase × price / 1e18`, fee summed then **clamped ≥ 0** (a maker rebate is zero
  cost). Deduped + ordered by `submission_idx`.
- **Terminality / reconciliation** → a gone order (`getOrder` → not-found) with confirmed fills
  is terminal; a FRESH `getSubaccountSummary` net position is the reconciliation check.

> 🔄 **Design divergence from the original brief (flag):** the brief recommended reading the
> taker's `filledX18/quoteFilledX18/feePaidX18` directly from the `fill` WS stream. The A-5
> pre-audit found that naive-WS-authoritative path carries a 1e18 quote-scale bug, a
> non-monotonic-quote regression-pause, a maker-rebate negative-fee bug, and a missed-fill →
> double-trade risk. So the WS stream is used as the WAKE + per-fill feed with **corrected
> math**, and terminality/completeness leans on the engine + a position check — matching this
> section's own "proven by position reconciliation" wording. An alternative authoritative source,
> the **indexer `getMatchEvents`** (cumulative `cumulative_base_filled`/`_quote_filled` x18,
> monotonic by construction, but `@nadohq/indexer-client` is not a current dep and no testnet
> indexer endpoint is exported), should be evaluated at the gate; the fill reads are injectable
> so the source is swappable without touching the connector.

Confirm LIVE (the shape-dependent items the offline build is injected around):
- [ ] **Pin the raw `fill` frame shape** with a short capture: that `filled_qty`/`remaining_qty`/
      `original_qty`/`price`/`fee` are X18, and whether `filled_qty` is per-match-incremental or
      cumulative (the accumulator derives base from original−remaining, robust to either; confirm).
- [ ] **`getOrder` not-found shape** — the structured code/envelope that means "order left the
      book", so `fill-source.isOrderNotFound` distinguishes it from a transport/WAF failure
      (which must stay `unavailable` → not-observable, NEVER read as terminal).
- [ ] **IOC finality by position reconciliation** — a partial IOC settles terminal with the
      correct filled qty, and a fresh net position equals the summed confirmed fill (per wallet,
      flat-start; this is the explicit A-5 gate, not inferred from a missing cancel row).
- [ ] The resting maker's fill while it rests (`getOrder` filled) matches what the cross then
      consumes (no gap at the maker→terminal transition when B crosses it).
- [ ] A gone order whose fill is not yet observed returns `undefined` → the coordinator's lag
      window waits (NEVER `{filled:0, terminal:true}`, which would re-send a duplicate live order).

## 3. Self-cross mechanism (open + close)
- [ ] On a thin/empty testnet book, A's post-only maker **rests** (is not auto-crossed) and B's
      IOC **crosses it deterministically** (B is effectively the sole counterparty). Where other
      liquidity exists, A rests at/through top-of-book so B reaches A first.
- [ ] The close mirrors: B's reduce-only maker rests and A's reduce-only IOC crosses it; both legs
      end flat. Confirm no residual position/open order after a round.
- [ ] A is never cancelled before B crosses it (and B's close maker never before A crosses) —
      watch for an accidental early cancel under real latency/retries.

## 4. STP scope (decides whether B-2 is pulled into Phase A)
- [ ] A and B are **distinct per-wallet EIP-712 subaccounts**, so a standard per-subaccount STP
      should NOT touch the intended A↔B cross. **Confirm on testnet** that Nado does not apply an
      account-group / operator-level STP that would auto-cancel the A↔B cross.
- [ ] If it would: pull the B-2 permit config (`selfTradePrevention`) forward into Phase A so the
      intended cross is permitted. If not: B-2 stays the Phase-B policy for *unintended* cross-pair.

## 5. Sizing sanity (the X18 / min-notional trap)
- [ ] Order size quantized via `getSymbols` tick/step and `adapter-nado/sizing.ts`
      (`clampOrderSize`): `minSize` is a USDT0 **min-notional** (X18), NOT a base size — confirm a
      live order is NOT inflated ~10,000× (the known bug class), and clears the min notional.
- [ ] `price × size` notional and the order's signed X18 `amount` match the human size intended.

## 6. Run-integrity gates (what invalidates a run)
- [ ] A **double-place** or an **unexpected 429-storm below target** invalidates the run.
- [ ] Hitting the **known single-IP WAF / read-budget ceiling** is the accepted boundary, NOT an
      invalid run — report "sustained fills/sec up to the first halt".
- [ ] A **global halt** (an UNKNOWN / fatal) is run-terminating; never count zeros past it.
