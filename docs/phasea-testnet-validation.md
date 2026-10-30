# Phase A — testnet validation checklist (operator step)

The offline Phase-A work (experiment A/B FSM, max-throughput mode, self-cross open/close,
`@farm/loadgen` idempotency + dispatch classification + cohort settle gate, and the
fake-gateway `ExperimentConnector` skeleton) is unit-tested with mocks only. Static/mocked
gates are **necessary but not sufficient** for the live order path: the items below MUST be
confirmed against the real Nado sequencer on **testnet** before any capacity number is
trusted, and before the connector's live wiring is relied on.

**Testnet only.** Mainnet stays gated behind explicit user authorization (decision #7).
Untrusted code never touches real funds; the cohort is pre-funded out of band (seed script).

## 1. Dispatch classification code table (`@farm/loadgen` `classify.ts`)
The `classifyDispatch` policy maps sequencer/transport outcomes to deduped / not-sent /
refused / rejected-fatal / unknown. The code sets are grounded in the dedup + WAF notes but
must be confirmed against the LIVE sequencer:
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
especially for the taker (B on open, A on close) that never rests. Confirm the live source:
- [ ] The keyless **public `fill` stream** (the decided wake transport) and/or an
      **order-by-digest** query give the authoritative per-order filled base qty. (Base
      `getFills` returns `[]`; `@nadohq`'s per-order query API must be identified + mapped.)
- [ ] **IOC finality is proven by position reconciliation** (cumulative confirmed fill vs a FRESH
      engine position), NOT by a missing "cancelled" row. Confirm a partial IOC settles terminal
      with the correct filled qty, and a fresh position read matches the summed fills.
- [ ] The resting maker's fill while it rests (open-orders `filled`) matches what the cross then
      consumes (no gap at the maker→terminal transition when B crosses it).

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
