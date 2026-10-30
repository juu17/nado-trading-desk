# LEG 3 — live N=1 sustained self-cross baseline (result)

Run of `packages/loadgen/src/testnet-sustained.test.ts` on Ink testnet, immediately after the
root-cause refusal fix (`2bda5d0`). Cohort: **A** (maker, HD index 0) + **B2** (taker, HD index 2,
fresh/flat). B (index 1, parked with BTC inventory) and the BTC book were untouched. Raw result
JSON + full log were written to the session scratchpad (not committed — they carry local paths).

## Setup
- **Market (auto-picked, no `AB_PRODUCT_ID`):** JUP-PERP (productId 86), tick 0.00001, 2-tick spread at selection.
- **Window:** 150 s (TURBO slot, free dial N=1, max round-rate). Span measured: 125.8 s.
- **Baseline:** A = 0, B2 = 0 (flat start). ✓

## Headline — the fix is validated live
- The run hit **~220 live `2008` (post-only-would-cross) refusals** and resolved every one locally
  (terminal/zero-fill, re-price) — **no hang, no false `EXPERIMENT_LOOKUP_UNKNOWN`, no abort**.
- The run-terminating gate (genuine UNKNOWN / fatal / double-place) **never fired**.
- Ended **flat + settled**: A = 0 (base 0), B2 = 0 (base 0), back to baseline; `flatSettled = true`,
  no residue. This is the exact live blocker the effort targeted, now fixed and proven under load.

## Throughput (⚠️ venue-limited, see ceiling cause)
| metric | value |
|---|---|
| matched fills | 10 (5 fully-hedged round-trips) |
| fills/sec (windowed) | 0.067 over 125.8 s |
| rounds opened | 73 |
| rounds that matched | 5 |
| A_OPEN post attempts | 225 |
| A_OPEN posts that rested + were crossed (B_OPEN) | 5 |

**Fills/sec timeseries (5 s buckets):** `0,0,2,0,…,0,2,4,2,0,0,0` — matches clustered in two brief
stable windows; otherwise zero.

**Fill-confirm latency** (8 samples from the 5 matched rounds): open p50 154 ms / p99 217 ms;
close p50 428 ms / p99 583 ms; overall p50 172 ms / p99 583 ms.

## Race-loss
- **~220 / 225 A_OPEN post attempts (97.8 %) were refused `2008`** — the post-only maker at best±tick
  crossed the book by submit time. Only 5 posts rested.
- **68 / 73 rounds (93 %) produced no matched self-cross.**
- These race-losses exited via the **open-window-close** path (the maker got a few re-priced `2008`s,
  then the short TURBO open window elapsed → round completes flat → fresh round). The 5-attempt
  reprice cap (`REPRICE_EXHAUSTED_EXIT`) and the cross-round `EXPERIMENT_MARKET_UNPRICEABLE` backstop
  were **never reached** (window closes before 5 refusals accrue in one round), so the pair stayed
  ACTIVE and kept cycling fresh rounds.

## Ceiling cause
The ceiling is the **venue / market microstructure, not the client egress or the coordinator.** On
JUP-PERP's thin, fast-moving testnet book a post-only maker priced at best±tick almost always crosses
(≈98 %) between the prepare book-read and the submit, so it rarely rests long enough to be
self-crossed. The write budget (8/s), the single IP, and the coordinator were nowhere near saturated.

## Measurement-semantics caveat
`0.067 fills/sec` is **the venue's maker-rejection rate at N=1, not the harness's egress capacity.**
A harness-limited N=1 baseline needs the maker to rest reliably — either a market with a persistently
wider/stable spread, or a deeper maker placement (best±N ticks) that survives small book moves to
submit. Decision pending before any further runs.
