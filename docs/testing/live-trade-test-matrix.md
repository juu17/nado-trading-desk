<!-- Auto-designed test matrix (Wave: live-trade verification). Review before executing. -->

# Nado Trades/Orders — Fully Live-Proven Test Matrix

> Ink testnet · chainId **763373** · live sequencer `api.test.nado.xyz` · in-tab wative EIP-712 sign + **keyless relay** submit.
> Compiled 2026-10-18 from the four enumerated factor groups (Order params · Signing/custody · Lifecycle/dedup · Environment/scale), de-duplicated into 10 coherent dimensions.

## 1. Scope & what "fully live-proven" means

**Under test:** a single Nado order's full knob-space (place / cancel / replace / close) and everything that can change its acceptance, fill, lifecycle or rejection — signed **in-tab** by a per-wallet EOA (`live:i`), submitted through the single-egress-IP **keyless relay** (`/api/nado/relay/*`) to the live Ink-testnet sequencer. The server holds **no key**.

**"Fully live-proven"** = every *meaningful* factor and interaction has a **real sequencer result on testnet** — a `status:success` + digest, an observed `order_update`/`fill`, a live dedup rejection, or a captured numeric error code — **not** merely an offline-conformance pass (byte-identical EIP-712 + ecrecover) or an SDK-derived expectation. The gap this matrix closes: much of the economic surface is green *offline*, and a thin slice is green *live* (Phase 1b/2/3), but whole columns (SELL resting maker, **all SPOT**, every deliberate reject code, the entire dedup triad 2013/2011/2004) have **never been fired at the live sequencer**.

**Proof-status legend**

| mark | meaning |
|---|---|
| ✅ | **live-proven** on testnet (Phase 1b / 2 / 3) |
| 🟡 | **offline-conformance** only (unit/property test, byte-identical + ecrecover) |
| 🔵 | **SDK/code-grounded** (RE'd from `@nadohq` engine or a standalone probe; not fired from the live app path) |
| 🔴 | **UNTESTED-live** |
| ⚙️ | **NOT-WIRED / code-gap** (capability declared or input accepted but the adapter never encodes it) |

---

## 2. Dimension tables

### D1 — Product & market

| factor | values | affects | expected (incl. code) | proof | ground-truth |
|---|---|---|---|---|---|
| product type | perp (`type===1`) · spot (e.g. INK-USDT0) · any of 95 live markets · unmapped id | selects `productId` → per-market order `verifyingContract`; `kind` label | perp+spot both accept with correct per-product addr → success; unmapped → client `unknown Nado market` (never reaches sequencer) | perp ✅ (1b); **spot 🔴**; unmapped 🟡 | `execute.ts:162`; `adapter.ts:67-71`; `_live.ts:82` |
| market lifecycle state | active · halted/paused · delisted · zero-liquidity | `getSymbols` is sole market source; no halt/delist branch | active→success; delisted→absent→client reject; halted→sequencer reject **code unknown** | 🔴 | `_live.ts:72` |
| spot-specific path | identical order path as perp? or needs `hints.spotLeverage` / diff domain | whether spot reuses the proven perp signing path | **OPEN** — only perp (product 2) proven live | 🔴 | open-question (group 1) |

### D2 — Direction · kind · TIF · role

| factor | values | affects | expected (incl. code) | proof | ground-truth |
|---|---|---|---|---|---|
| side | buy · sell | amount sign: +sizeAbs (buy) / −sizeAbs (sell) | buy→amount>0; sell→amount<0 | buy ✅(1b); sell 🟡 byte-identical + ✅ only **via close IOC**; **standalone resting SELL 🔴** | `execute.ts:146`; `execute.test.ts:37-38` |
| kind | limit · market | `execTypeFor`: market→ioc(513); limit→flags. Live path **hardcodes `kind:'limit'`**, emulates market via crossing IOC | limit→success; `kind:'market'` input path **never emitted live** | limit ✅(1b); market-input ⚙️🔴 | `execute.ts:120-126`; `liveContext.ts:221` |
| tif | ioc · gtc · fok · gtt · undefined | **CODE GAP:** `execTypeFor` honors **only `ioc`**; gtc/fok/gtt/undefined → `default(1)` | ioc→513✅; gtc→default(1); **fok→silent downgrade to default(1), NO fill-or-kill**; gtt→no distinct expiry | ioc ✅; gtc ✅; **fok/gtt ⚙️🔴** | `execute.ts:120-126` (confirmed) |
| maker vs taker | maker (post_only, rests) · taker (IOC crossing, fills) | price fallback mid×0.9/×1.1 (maker) vs ask×1.002/bid×0.998 (taker) | maker→resting; taker→fills + cancels remainder, emits fills | maker ✅(1b); taker ✅(2, opened ~18-unit long) | `liveContext.ts:206-223` |
| postOnly | true · false | true→appendix 1537 maker-only | resting price→rests; **crossing price→reject (2008 POST_ONLY_CROSSES, code 🔵)** | resting ✅; would-cross 🔴 | `execute.ts:122,158` |

### D3 — Price · size · units · validation bounds

| factor | values | affects | expected (incl. code) | proof | ground-truth |
|---|---|---|---|---|---|
| price vs oracle band | inside 80-120% · crossing-in-band · outside | sequencer validates vs oracle band | inside→rests; crossing→fills; **outside→2007 ORACLE_PRICE_DIFFERENCE** | inside+crossing ✅; 2007 ✅ observed in calibration (not a standing test) | `liveContext.ts:209-210` |
| tick alignment | aligned · raw-unaligned | client rounds to nearest tick (info `TICK_ROUNDED`) | aligned→accepted; **raw→2000 INVALID_PRICE_INCREMENT** (client aligns first, so 🔴 live) | client-align 🟡; sequencer-reject 🔴 | `validate.ts:48-53`; `liveContext.ts:213` |
| size vs minSize / min-notional | below-min · at-min · mid · large | `clampOrderSize` floors to step then bumps **up** to clear the min-notional; the getSymbols `minSize` field is a misnamed uniform **100 USDT0 min-NOTIONAL**, so the notional floor **is 100** (verified live 2026-10-18) | below-min→clamped-up→success; a <100 notional is bumped up to clear 100; deliberate below-min→**2003 ORDER_AMOUNT_TOO_SMALL (🔵)** | clamp 🟡; below-min live 🔴; minNotional=100 ✅ | `adapter-nado/sizing.ts:9-41`; `_live.ts:90-98` |
| size step alignment | aligned · rounds-down · rounds-to-zero | rounds **down** to step; zero→`NON_POSITIVE_SIZE` client reject | aligned→ok; unaligned→rounded down; zero→client reject (never submitted); **raw→2001 INVALID_AMOUNT_INCREMENT (🔵)** | 🟡; live 🔴 | `validate.ts:37-45`; `_live.ts:88` |
| unit domain split | price HUMAN · size X18 signed · withdraw NATIVE-6 | wrong domain mis-scales 1e12 → wrong size or reject | correct split→success; **X18 withdraw→2036 SUBACCOUNT_HEALTH_TOO_LOW** (via 1e12 over-scale, a health trip, not a decimals code) | ✅(1b "unit split nailed"); X18-withdraw→2036 ✅ observed | `execute.ts:10-18,146` |

### D4 — Appendix · margin · advanced flags

| factor | values | affects | expected (incl. code) | proof | ground-truth |
|---|---|---|---|---|---|
| appendix + version | default(1)·ioc(513)·fok(1025)·post_only(1537); reduceOnly\|2048 | **signed** field; version 1 required | v1→success; **appendix 0 / wrong version→2095 INVALID_ORDER_VERSION** | v1 ✅; **2095 ✅** observed live | `execute.ts:158`; `execute.test.ts:48-49` |
| reduceOnly | true · false | OR 2048 (ioc+reduce=2561); caps fill at position, never flips | true→capped; against flat→no fill; **non-taker→2067; grows position→2064 (🔵)** | appendix 2561 🟡; close-path ✅(2); 2064/2067 🔴 | `execute.ts:155-158`; `execute.test.ts:49` |
| margin mode | cross (default) · isolated | **NOT WIRED:** `packOrderAppendix` called with only `{orderExecutionType, reduceOnly}`; every order implicitly cross | cross→success; **isolated not expressible** (would place as cross) | cross ✅; isolated ⚙️🔴 | `execute.ts:158`; `live-gateway.ts:211` |
| leverage | 1x..max | **no per-order field**; subaccount/position-level, out-of-band | no per-order effect | ⚙️🔴 out of order scope | `execute.ts` (absent) |
| triggers tp/sl/twap | none · tp · sl · twap | **PASS-THROUGH ONLY [#12]:** `execute.ts` ignores `trigger` | "trigger" order places as plain limit/ioc | ⚙️🔴 | `manifest.ts:25`; `execute.ts:158` |
| selfTradePrevention | none · cancel-oldest/newest/both | **PASS-THROUGH ONLY [#12]:** never serialized | STP has **no effect**; sequencer default on self-cross **unverified** | ⚙️🔴 | `manifest.ts:24` |
| builder fee | none · {builderId, builderFeeRate} | appendix bits 38-63; **NOT WIRED** | no builder fee; not expressible | ⚙️🔴 | `execute.ts:158` |

### D5 — Signing & custody

| factor | values | affects | expected (incl. code) | proof | ground-truth |
|---|---|---|---|---|---|
| EIP-712 scheme | strict `signTypedData` (the only order path) · `signDigest` (dead) · malformed | whether the strict validator accepts | strict→accepted byte-identical, **no 2028 INVALID_SIGNER**; signDigest never exercised; malformed→2028 | ✅(1a+1b, no fallback needed); signDigest 🔴/dead | `custody.ts:105-108` |
| ecrecover / byte-identity | byte-identical rebuild · field drift | sequencer reconstructs domain+message, ecrecovers | identical→recover==owner; drift→reject | ✅(property test 24 orders + 1b) | `execute.ts:160`; `conformance.test.ts` |
| domain verifyingContract per type | order=`getOrderVerifyingAddress(productId)` (per-market); cancel/withdraw/streamauth=Endpoint; ZERO_ENDPOINT fallback | domain separator | per-product+Endpoint→accepted; **cancel w/ ZERO_ENDPOINT→"Invalid address"** | order+withdraw+cancel ✅(1b/2); ZERO_ENDPOINT 🔴 | `execute.ts:162-240`; `adapter.ts:170-173` |
| SignatureParams at submit | verifyingAddr+chainId present · either omitted | sequencer rebuilds domain | both→accepted; **omit→"Invalid address"** (string, not numeric) | ✅ observed live | `live-gateway.ts:132-134` |
| chainId value | 763373 testnet · 57073 mainnet · 57073 placeholder (unused) | domain chainId; **wrong→2093 NOT_CANONICAL_CHAIN** | 763373→accepted; mainnet→full re-validation gate; 2093 on wrong | 763373 ✅; mainnet 🔴; 2093 🔴 | `liveContext.ts:26-27`; `manifest.ts:46` |
| which wallet signs | unlocked `live:i` · locked · bad id · treasury `live:0` | per-EOA key; locked/missing throws **before** submit | own-EOA signs+submits; locked/bad→throws (no submit); treasury is also a valid signer | ✅(3a, per-EOA distinct sigs; out-of-range rejected) | `custody.ts:96-124` |
| subaccount | `default` (bytes32 sender) · non-default (banned) | `sender` field + stream subject | default→accepted; non-default→architecturally banned | default ✅; non-default N/A | `custody.ts:59` |
| link_signer / delegation | link_signer execute · delegatedSigner declared | delegation path | signs+accepted (Phase 1); **not on hot path, delegation unused** | sign/recover ✅; app-use 🔴 | `manifest.ts:35` |

### D6 — Account / funding state

| factor | values | affects | expected (incl. code) | proof | ground-truth |
|---|---|---|---|---|---|
| funding state | unfunded · funded (gas<floor) · ready | order needs credited collateral (gasless); readiness is display-only | unfunded→**insufficient-collateral reject (exact code OPEN: 2006/2036/2024-class)**; funded/ready→accepted | readiness 🟡; live reject 🔴 (code not captured) | `readiness.ts:20-28`; `live.ts:89-95` |
| subaccount existence | never-deposited · first deposit creates · exists | trade/withdraw before existence → no collateral | pre-deposit→**2024 NO_PRIOR_DEPOSIT-class**; deposit creates `default`; then accepted | deposit-creates ✅(2); pre-existence reject 🔴 | `manifest.ts:31` |
| mainnet screening | ok · risk-high · pending | per-address block at mainnet | **2021 ADDRESS_RISK_TOO_HIGH / 2023 SCREENING_PENDING** (terminal) | 🔴 (testnet doesn't exercise) | `@nadohq errorCodes 2021/2023` |

### D7 — Lifecycle · cancel · replace · position · status

| factor | values | affects | expected (incl. code) | proof | ground-truth |
|---|---|---|---|---|---|
| cancel target | venueId=digest · clientId · cancel-on-market · multi-digest batch | digests[] vs productIds[] | digest cancel→success; clientId is **local-only no-op at venue**; empty-venueIds cancel-all-on-product unwired | digest ✅(1b/2); clientId/all-on-product 🔴 | `execute.ts:179`; `liveContext.ts:234-246` |
| cancel of gone digest | non-existent · filled · already-cancelled · expired | result mapping | **UNKNOWN envelope:** `data.cancelled_orders ?? signed.digests` can **falsely report requested digests as cancelled**; read-first path returns `{cancelled:[]}` (safe) | 🔴 (false-positive risk) | `live-gateway.ts:161-163` |
| cancel domain | Endpoint · ZERO_ENDPOINT | cancel domain | Endpoint→accepted; **ZERO→"Invalid address"** | Endpoint ✅(2); ZERO 🔴 | `execute.ts:187-188` |
| replace / cancel_and_place | replace op; manifest `batchReplace:true` | atomicity | **GAP:** adapter does sequential cancel-then-place (two submits, non-atomic); **live console throws "not replace" → unreachable** | ⚙️🔴 | `adapter.ts:133-136`; `runtime.ts:112-115` |
| position intent | open · flatten · flip | side/size/reduceOnly | open→place; flatten→opposite reduceOnly IOC (size=\|pos\|); **flip→no path builds it (reduceOnly caps, never flips)** | open ✅; flatten ✅(2); flip 🔴 | `liveContext.ts:249-263` |
| status transitions | pending→open→partial→filled\|cancelled\|rejected\|expired | reported status | submit→`open`; reads derive only open/partial; filled/cancelled/rejected/expired leave `getOpenOrders`; order_update reasons observed: **placed\|filled\|cancelled only** | open/partial 🟡; placed/filled/cancelled ✅(2 spike); rejected/expired reason 🔴 | `live-gateway.ts:121`; `order-update-ws-auth.md §3.3` |
| partial fills | 0<filled<total | filled/remaining/status=partial | mapping sound; **never observed** on thin testnet book | 🟡; live 🔴 | `live-gateway.ts:108-123` |

### D8 — Dedup / idempotency

| factor | values | affects | expected (incl. code) | proof | ground-truth |
|---|---|---|---|---|---|
| digest dedup | byte-identical resubmit · any-field-changed | **digest-keyed** (not nonce-keyed) | identical→**2013 DIGEST_ALREADY_EXISTS** (safe, no double-place); changed→new digest, places again | 🔵 (SDK + Wave B audit); **deliberate-2013 🔴** | dedup memory; `liveContext.ts:150-165` |
| recvTime window | fresh (now+90s) · stale (>~90s) · >100s early | nonce `(recvTime_ms<<20)\|random` | fresh→success; **stale→2011 LATE_RECV_EXECUTION** (fails safe); **early→2012 EARLY_RECV_EXECUTION** | 🔵; deliberate-2011/2012 🔴 | dedup memory; `liveContext.ts:156-160` |
| expiration | default now+7d · custom gtt · past | signed digest field | future→rests; **past→2004 ORDER_EXPIRED** (fails safe); gtt custom-expiry **not wired (`expiryMs` unused)** | 7d default ✅(1b); deliberate-2004 🔴; gtt ⚙️🔴 | `execute.ts:34,144` |
| jobId memoization | same jobId · no jobId · different jobId | client no-double-place **before** network | same→`submitted` returns prior Order (no network); no jobId→fresh each fire; stabilizes **nonce+expiration+price+size+reduceOnly** | in-memory idempotency ✅(3a re-fire returned prior order); sequencer dedup 🔴 | `liveContext.ts:149-231` |
| idempotency field stability | nonce+exp only (INSUFFICIENT) · +price+size+reduceOnly (CORRECT) | book-derived retry staying byte-identical | stabilizing only nonce/exp → re-prices → double-place; full set keeps digest identical | 🟡; live 🔴 | `liveContext.ts:164-165` (Wave B HIGH) |
| store persistence | in-memory (today) · persisted job store | survival across reload | in-memory consistent today; **a persisted store without persisting these maps → post-reload nonce re-mint → double-place regression** | 🟡 risk; 🔴 | `liveContext.ts:150`; `bulk.ts:34` |
| cancel idempotency | retry cancel · cancel after gone | fresh `getOrderNonce` each retry (new digest); read-first mitigates | re-cancel of gone order→`{cancelled:[]}`; direct adapter cancel of stale digest **UNKNOWN** | 🔴 | `execute.ts:178`; `liveContext.ts:237-244` |

### D9 — Streams / observation

| factor | values | affects | expected (incl. code) | proof | ground-truth |
|---|---|---|---|---|---|
| order_update WS auth | valid own-wallet · none · foreign-wallet · bad-sig/skew | auth-gated real-time order state; EIP-712 StreamAuthentication, in-tab, direct browser | authed→events; none/foreign→reject; bad/skew→**terminal**, fall back to poll | scheme + foreign-reject 🔵/✅ (probe); **in-app end-to-end 🔴** | `orderUpdateStream.ts:29-85` |
| StreamAuth expiration | now+60000ms (≤100s) · past · >100s | **MILLISECONDS** (unlike order=seconds) | in-window→authed; out→auth error (terminal) | scheme 🔵; in-app 60s value 🔴 | `orderUpdateStream.ts:35-44` |
| public streams | fill · position_change · book (keyless) | scalable reconcile over one shared socket | subscribe by subaccount hex→events, no sig | fill ✅(2a); **position_change keyless-at-scale 🔴**; subject cap unmeasured | `manifest.ts:65-78`; ws-auth memory |
| order_update scale budget | bounded working set · full cohort · >5 conns/wallet | per-wallet/per-connection, no refresh; ~1000 EOAs = ~1000 sockets (doesn't scale) | bounded→ok; full cohort→doesn't scale; **>5/wallet→reject** | 5-cap 🔵/✅; ~1000-socket ceiling 🔴 | `manifest.ts:66` |

### D10 — Environment · transport · rate-limit · scale · error matrix

| factor | values | affects | expected (incl. code) | proof | ground-truth |
|---|---|---|---|---|---|
| per-IP READ bucket (`nado:rest`) | ≤2/s steady · burst 6 · over | whole cohort shares one relay-IP bucket; gates reads+cancels | within→granted; over→client blocks; residual→**429 / 1000 RATE_LIMIT**, relay retries | ✅(3b: 3/s clean, 5/s+ throttled, burst≥12; relay 16/16+10/10) | `manifest.ts:50-64`; `limiter.ts` |
| per-subaccount ORDER bucket (`nado:place`) | 10/5s per subaccount · at 1000 EOAs | per-subaccount isolated; aggregate still one relay IP | within→granted; over→blocks/429 | **🔴 `verifiedOnTestnet:false`** | `manifest.ts:63`; `live-gateway.ts:135-138` |
| cohort concurrency / kill-switch | 1 · ~50 cap · 972 mock · 1000+ real · mass-cancel | serial lanes under 50-cap; mass-cancel on `nado:rest` | paced by limiter + relay backoff; single egress IP is the open risk | small-scale ✅(3 real + 972 mock); **100-1000 real 🔴** | `bulk.ts:44`; `liveContext.ts:372-376` |
| read-budget reservation | high · low · exhausted | sweep yields to interactive ops; summary single-flight | low budget→sweep yields; ops still acquire | 🟡; live-at-scale 🔴 | `liveContext.ts:341-376`; `live-gateway.ts:81-93` |
| Accept-Encoding WAF (REST) | absent→403 · gzip/br/deflate→200 | transport gate; relay (undici)+browsers unaffected; raw curl tripped | undici/browser→200; curl w/o `--compressed`→**403 "Invalid compression headers"** (WAF, not cooldown) | ✅(1b, 68KB all_products) | sequencer-WAF memory; `relay route:53` |
| WS compression (WS) | with permessage-deflate · without | fill/position_change/order_update all need it; code opens **bare `new WebSocket`** | browser→implicit ok; **Node WS w/o→2080 WEBSOCKET_COMPRESSION_REQUIRED** | 🔴 (browser implicit, never explicitly proven) | `liveStream.ts:41`; `orderUpdateStream.ts:31` |
| relay availability | 2xx · transient 429 (≤4 retries backoff+jitter) · sustained 429 · 502 · 503 · 400 | single choke point; **throws on non-2xx → FAILED job, never silent open** | transient→recovered; sustained/502/503/400→throw→FAILED | transient ✅(3b); sustained give-up + convergence 🔴 | `relay route:26-65`; `liveContext.ts:82-95` |
| oracle band drift | in-band at submit · moved out before submit · post-only would cross after move | build→submit latency × volatility | stale→**2007**; resting maker crossing after move→**2008 POST_ONLY_CROSSES** | 2007 ✅(1b); 2008 🔴 | `liveContext.ts:173-218` |
| clock skew | in-window · >100s ahead | raw browser clock drives nonce+streamauth; **ClockSync scaffold NOT wired** | skew→**2011/2012** + StreamAuth rejects | 🔵; live 🔴; ⚠️ unwired | `liveContext.ts:136,216` |
| dynamic fee | adequate max_fee · spike exceeds | adapter sets **no max_fee/builder field** | fee spike→**2135 FEE_TOO_LOW** (re-quote) — behavior unknown | 🔴 | `execute.ts` (no max_fee) |
| market mode / halt / funding | normal · 2069 blocked · 2117 post-only · 2119 reduce-only · 2122 isolated-only · 2070 max-OI · 2071 max-util · perp funding window | mode gates order types; funding shifts margin | each mode rejects incompatible order; OI/util cap new size | 🔴 (none observed) | `@nadohq errorCodes`; `liveStream.ts:22-26` |
| service/outage/geo | 1004 maintenance · 1006 unavailable · 5000 internal · 1001/1002/1003 geo/blacklist · 1005 gateway-invalid | cohort-wide transient vs per-address terminal | 1004/1006/5000→transient-retry; 1001-1003→terminal | 🔴 | `@nadohq errorCodes 1xxx/5000` |
| signature/payload shape | 2027 length · 2034 invalid-v · 2035 sig-error · 2022 invalid-nonce | signing-conformance surface | malformed→respective code; 2028 **proven NOT to occur** | 2028-absence ✅; 2027/2034/2035/2022 🔴 | `@nadohq errorCodes` |
| partial-failure / retry-failed-only | clean · ~8% fault · live reject→FAILED | scheduler retries only `failed`; idempotent → 2013-safe | 972 clean; fault→done/failed split→retry converges | mock ✅(1b); real 100-1000 🔴 | `bulk.ts:51-87` |
| fresh-EOA bootstrap | funded+deposited · fresh no-deposit | each of 1000 must gas→mint→deposit before any order | pre-deposit→fails; funding must precede trading | bootstrap ✅(3 EOAs); scale + mainnet-screening 🔴 | `liveContext.ts:640-687` |
| degraded RPC (native gas read) | healthy · slow(>6s abort) · hung | keyless SWR, timeout-bounded, **excluded from critical batch** | hung→aborts, serves stale/unfunded badge, never stalls sweep | 🟡; live degraded 🔴 | `liveContext.ts:265-356` |

---

## 3. Concrete test-case list (matrix cells)

IDs are stable. Oracle = how to verify. Each case is a meaningful cell (full cross-product pruned to each factor + the load-bearing interactions).

### (A) Happy-path placements — buy/sell × spot/perp × maker/taker

| id | title | preconditions | inputs | expected | oracle | proof |
|---|---|---|---|---|---|---|
| **A1** | perp maker BUY rests | funded perp wallet (BTC-PERP) | buy·limit·post_only·price=mid×0.9·size≥min | `status:success`+digest, rests | sequencer status+digest; `getOpenOrders` shows open:1 | ✅ |
| **A2** | **perp maker SELL rests** | funded perp | sell·limit·post_only·price=mid×1.1·size≥min | success, rests inside band (amount<0) | status+digest; open:1; confirm **resting** (not close) | 🔴 **gap** |
| **A3** | perp taker BUY IOC fills | perp, resting ask liquidity | buy·ioc·price=ask×1.002 | fills, cancels remainder, long opens | status+digest; live `fill` event; position delta | ✅ |
| **A4** | perp taker SELL IOC fills | perp, long/ask present | sell·ioc·price=bid×0.998 | fills + cancels remainder | `fill` event; position reduces | ✅ via close; standalone 🟡 |
| **A5** | **spot maker BUY rests** | funded spot wallet (INK-USDT0) | buy·limit·post_only·mid×0.9 | success, rests — **proves spot reuses perp path** | status+digest; spot `getOpenOrders` | 🔴 **#1 gap** |
| **A6** | **spot maker SELL rests** | funded spot | sell·limit·post_only·mid×1.1 | success, rests | status+digest | 🔴 **gap** |
| **A7** | spot taker BUY IOC | spot, ask liquidity | buy·ioc·ask×1.002 | fills | `fill` event | 🔴 |
| **A8** | spot taker SELL IOC | spot, bid liquidity | sell·ioc·bid×0.998 | fills | `fill` event | 🔴 |
| **A9** | plain gtc limit (appendix 1) | perp | buy·limit·gtc·(no postOnly, no ioc) | rests as default(1) — **never fired live** (console always post_only/ioc) | status+digest; appendix echo==1 | 🔴 |
| **A10** | reduceOnly close (flatten) | open long | opposite·ioc·reduceOnly·size=\|pos\| | position→0, no flip | position reads flat; wallet clean | ✅ |

### (B) Validation / reject cases

| id | title | preconditions | inputs | expected | oracle | proof |
|---|---|---|---|---|---|---|
| **B1** | price >120% band | perp | post_only·price=mid×1.3 | **2007** | sequencer error_code 2007 | ✅ (calibration) |
| **B2** | price <80% band | perp | post_only·price=mid×0.5 | **2007** | error_code 2007 | ✅ (calibration) |
| **B3** | appendix version 0 | perp | appendix forced 0 | **2095** | error_code 2095 | ✅ |
| **B4** | missing verifyingAddr/chainId | perp | omit SignatureParams | string **"Invalid address"** | error body text | ✅ |
| **B5** | withdraw amount X18 | funded | withdraw amount ×1e12 | **2036** (health trip) | error_code 2036 | ✅ |
| **B6** | unmapped marketId | any | marketId not in 95-map | client `unknown Nado market` (no submit) | adapter throws pre-submit | 🟡 |
| **B7** | below-minSize (bypass clamp) | perp | size<minSize, clamp disabled | sequencer reject **2003** (code to capture) | error_code (OPEN) | 🔴 |
| **B8** | min-notional fires at 100 | perp | tiny notional <100 | **clampOrderSize bumps up** to clear the 100 USDT0 min-notional | size raised so notional ≥100, then accepted | ✅ (sizing.ts, verified 2026-10-18) |
| **B9** | post-only would cross | perp, tight book | post_only at crossing price | **2008** POST_ONLY_CROSSES (code to capture) | error_code (OPEN) | 🔴 |
| **B10** | raw unaligned tick | perp | price off-tick, align disabled | **2000** | error_code 2000 | 🔴 |
| **B11** | raw unaligned step | perp | size off-step, align disabled | **2001** | error_code 2001 | 🔴 |
| **B12** | zero/negative size | perp | size rounds to 0 | client `NON_POSITIVE_SIZE` (no submit) | adapter reject pre-submit | 🟡 |
| **B13** | insufficient collateral | unfunded-but-exists subaccount | any valid order | insufficient-collateral reject **2006/2036** (capture) | error_code (OPEN) | 🔴 |
| **B14** | order before deposit | never-deposited EOA | any order | **2024** NO_PRIOR_DEPOSIT-class | error_code (OPEN) | 🔴 |
| **B15** | halted/paused market | listed-but-halted | any order | reject (**2069/2117/2119/2122** per mode) | error_code (OPEN) | 🔴 |
| **B16** | wrong chainId | perp | chainId≠763373 | **2093** NOT_CANONICAL_CHAIN | error_code 2093 | 🔴 |
| **B17** | malformed signature | perp | corrupt sig length/v | **2027/2034/2035**; confirm **2028 does NOT fire** on strict | error_code | 🔴 (2028-absence ✅) |
| **B18** | fee spike | perp, fee rising | order w/ no max_fee during spike | **2135** FEE_TOO_LOW (if dynamic fees apply) | error_code 2135 | 🔴 |
| **B19** | reduceOnly on maker | perp | post_only·reduceOnly:true | **2067** REDUCE_ONLY_NOT_TAKER | error_code 2067 | 🔴 |
| **B20** | reduceOnly grows position | flat/opposite | reduceOnly order that would increase | **2064** REDUCE_ONLY_INCREASES_POSITION | error_code 2064 | 🔴 |

### (C) Lifecycle — cancel / replace / reduceOnly / partial / status

| id | title | preconditions | inputs | expected | oracle | proof |
|---|---|---|---|---|---|---|
| **C1** | cancel by digest | resting order | cancel venueIds=[digest] | success, order leaves book | status; `getOpenOrders` empty | ✅ |
| **C2** | cancel gone digest | already filled/cancelled | cancel that digest | capture real envelope; **flag false-positive** `cancelled??signed.digests` | compare response vs actual book | 🔴 |
| **C3** | cancel-all on product | ≥2 resting on market | cancel market set, empty venueIds | all on product cancel | book empty for product | 🔴 (unwired) |
| **C4** | cancel by clientId | resting | cancel clientIds=[x] | **no-op at venue** (clientId local-only) | venue ignores; structural | 🟡 |
| **C5** | replace / cancel_and_place | resting | replace op | live console **throws "not replace"**; non-atomic gap | runtime rejects; document gap | ⚙️🔴 |
| **C6** | partial fill | market/book deep enough | taker partially fills | status=`partial`, filled+remaining correct | `getOpenOrders` partial; then cancel leaves right remaining | 🔴 |
| **C7** | status via order_update | authed order_update stream | place→fill/cancel | reasons **placed\|filled\|cancelled** observed | WS order_update events | ✅(spike); in-app 🔴 |
| **C8** | flip through zero | open long | non-reduceOnly size>\|pos\| opposite | **no console path builds it** — confirm flip is/ isn't required | no path; design decision | 🔴 |
| **C9** | reduceOnly vs flat | flat position | reduceOnly IOC | no fill / reject | position unchanged | 🔴 |
| **C10** | FOK silent downgrade | perp | tif=fok | **placed as default(1), NO fill-or-kill** — confirm gap | appendix echo==1, order rests | ⚙️🔴 |
| **C11** | GTT custom expiry | perp | tif=gtt + expiryMs | **expiryMs not wired**; 7d default only | signed expiration==7d default | ⚙️🔴 |
| **C12** | cancel ZERO_ENDPOINT | adapter built w/o endpoint | cancel | **"Invalid address"** | error body text | 🔴 |

### (D) Dedup / idempotency — retry no-double-place

| id | title | preconditions | inputs | expected | oracle | proof |
|---|---|---|---|---|---|---|
| **D1** | byte-identical resubmit | accepted order | resubmit same digest | **2013** DIGEST_ALREADY_EXISTS, no double-place | error_code 2013; book shows ONE order | 🔴 **#1 dedup gap** |
| **D2** | stale resubmit (>~90s) | order built, wait ~90s | resubmit same nonce | **2011** LATE_RECV_EXECUTION (fails safe) | error_code 2011; no new order | 🔴 |
| **D3** | expired resubmit | order past expiration | resubmit | **2004** ORDER_EXPIRED (fails safe) | error_code 2004; no new order | 🔴 |
| **D4** | changed-field resubmit | accepted order | resubmit w/ price changed | **new digest → places again** (double-place if unintended) | TWO distinct digests on book | 🔴 |
| **D5** | same-jobId re-fire | jobId present | re-fire same job | **in-memory `submitted` returns prior Order**, no network | no second /execute POST; same digest | ✅(3a) |
| **D6** | clock skew → stale | skew clock >100s | normal order | **2011/2012** — ⚠️ ClockSync unwired | error_code; proves skew risk | 🔴 |
| **D7** | reload-then-retry | in-memory store | reload tab, retry job | **must not re-mint nonce** (else double-place) | same digest post-reload OR documented in-memory limit | 🔴 |
| **D8** | cancel retry idempotency | cancelled order | retry cancel (fresh nonce) | read-first → `{cancelled:[]}`; direct adapter cancel of stale digest envelope captured | response shape | 🔴 |

### (E) Environment / scale

| id | title | preconditions | inputs | expected | oracle | proof |
|---|---|---|---|---|---|---|
| **E1** | per-IP read 429 | live relay | sustained >3/s reads | throttle at 5/s+, burst≥12 tolerated; **429/1000** + relay retry | measured bands; 429 recovered | ✅(3b) |
| **E2** | per-subaccount place 10/5s | funded | >2/s places one subaccount | client blocks / 429 — **calibrate** | measured place rate vs bucket | 🔴 |
| **E3** | cohort concurrency 100-1000 | funded cohort | fire N concurrent real EOAs | single egress IP survives reads+writes OR needs sharding | throughput + 429 rate at scale | 🔴 |
| **E4** | kill-switch mass-cancel | many resting | cohort-wide cancel | fan-out on `nado:rest`, reserves headroom via readBudget | all cancel; no read starvation | 🔴 (small ✅) |
| **E5** | relay 429 backoff / sustained | burst + sustained | overload relay | transient recovered; **sustained→give-up→FAILED→retry converges (no thundering herd)** | relay logs; convergence | transient ✅; sustained 🔴 |
| **E6** | relay 502/503/400 | relay down / NADO_LIVE unset / bad path | trigger each | throw→**FAILED job** (never silent open) | job status=failed | 🔵 |
| **E7** | Accept-Encoding WAF | raw curl vs undici | probe REST | curl w/o `--compressed`→403; undici/browser→200 | 403 body vs 200 | ✅ |
| **E8** | WS 2080 compression | Node WS probe w/o deflate | open fill/order_update | **2080** on Node w/o permessage-deflate; browser implicit ok | handshake result | 🔴 |
| **E9** | oracle band drift stale | volatile market | build in-band, submit after move | stale→**2007**; jobId retry reuses stabilized price (fails safe, not re-priced) | 2007 on stale; same digest on retry | partial |
| **E10** | order_update in-app e2e | authed drawer wallet | open stream in app | placed/filled/cancelled events render in console (not just probe) | in-app events | 🔴 |
| **E11** | order_update foreign/5-conn | authed socket | auth as A read B; open 6th conn | foreign→reject; **>5/wallet→reject** | reject responses | 🔵/✅ (probe) |
| **E12** | public position_change scale | cohort | keyless subscribe position_change | events return keyless at scale; measure subject cap | events + subject cap number | fill ✅; pos_change 🔴 |
| **E13** | degraded RPC gas read | slow/hung Ink RPC | native-balance read during sweep | aborts at 6s, serves stale/unfunded, **never stalls** critical batch | sweep latency unaffected | 🔴 |
| **E14** | fresh-EOA bootstrap scale | 1000 fresh EOAs | gas→mint→deposit→trade | bootstrap precedes trade; mainnet **2021/2023** screening at mainnet | all fund then trade; screening codes | 3-EOA ✅; scale+mainnet 🔴 |
| **E15** | outage / geo codes | — | observe/trigger | **1004/1006/5000** transient; **1001/1002/1003** terminal | error_codes | 🔴 |
| **E16** | market mode codes | mode-gated market | order into post-only/reduce-only/isolated-only/max-OI/max-util | **2069/2117/2119/2122/2070/2071** | error_codes | 🔴 |

**Total: 66 cases** (A:10, B:20, C:12, D:8, E:16).

---

## 4. Coverage summary

**Already GREEN — offline conformance (🟡):** EIP-712 byte-identity + ecrecover for place_order **buy AND negative-amount sell**, cancel_orders, withdraw_collateral, link_signer (property test over 24 random orders); appendix values 513/1537/2561; validate.ts tick/step/min rounding; readiness compute; in-memory idempotency logic.

**Already GREEN — live testnet (✅):**
- Phase 1b: **perp maker BUY** (product-2, rests, digest returned), **cancel_orders**, **withdraw_collateral** — strict `signTypedData`, **no signDigest fallback**; live-observed rejects **2095** (appendix v0), **2007** (band), **2036** (withdraw X18), **"Invalid address"** (missing SignatureParams).
- Phase 2: **taker IOC buy** (opened ~18-unit long), **reduceOnly close** (flattened, wallet clean), deposit-creates-subaccount, public **fill** stream, deposit/withdraw from UI.
- Phase 3a/3b: **per-EOA distinct signatures** + out-of-range id rejected; in-memory jobId re-fire returns prior Order; **per-IP rate-limit calibrated** (3/s clean, 5/s+ throttled, burst≥12; relay 16/16 paced + 10/10 burst recovered); **Accept-Encoding WAF** confirmed.

**STILL-OPEN live cells (🔴) — the gap:**
- 🎯 **The first and biggest gap: a live resting SELL maker (A2) and ALL live SPOT placements (A5-A8).** Every live proof to date is a **perp** order, and the only live SELL was *via a close IOC* (A10), never a standalone resting sell maker. Spot (type≠1) has **never been fired live** — it is an open question whether it reuses the proven perp path.
- The **entire dedup triad 2013/2011/2004** (D1-D3) is SDK-derived only — **never fired at the live sequencer**, yet the whole no-double-place guarantee hinges on it.
- Every **deliberate reject code** beyond the four already seen (B7-B20: insufficient collateral, below-min, unaligned, wrong chainId, sig-shape, fee, reduceOnly-misuse, market-mode, outage/geo).
- **Lifecycle**: partial fills, replace (gap — unreachable), flip, cancel-gone-digest envelope (false-positive risk), FOK/GTT (code gap).
- **Scale/env**: per-subaccount place bucket (verifiedOnTestnet:false), 100-1000 real concurrency on one egress IP, WS 2080, in-app order_update e2e, clock-skew (ClockSync unwired).
- **Not-wired (⚙️)** — declared but unencoded, so "test" = confirm the gap: isolated margin, leverage, triggers (tp/sl/twap), STP, builder fee, market-kind input, atomic replace.

---

## 5. Priority order (minimal ordered set that closes the gap first)

1. **A5 — live SPOT maker BUY** (first-ever spot placement; proves spot reuses the perp signing path or exposes the spot-domain question)
2. **A6 — live SPOT maker SELL**
3. **A2 — live perp resting SELL maker** (standalone, not via close; confirms mid×1.1 rests in band)
4. **A7 / A8 — live spot taker BUY / SELL IOC** (completes the spot happy-path grid)
5. **D1 — byte-identical resubmit → 2013** (the #1 dedup proof; the no-double-place guarantee)
6. **D2 — stale resubmit → 2011**, then **D3 — expired → 2004** (complete the dedup triad)
7. **D4 — changed-field resubmit double-places** (the negative control for D1)
8. **B13 / B14 — insufficient collateral / pre-deposit reject** (capture the real engine codes)
9. **B9 / B7 / B10 / B11 — post-only-would-cross, below-min, unaligned tick/step** (pin the four currently-masked reject codes)
10. **C6 — partial fill** (needs a deep-enough book; validates partial mapping + cancel-remainder)
11. **C2 / C12 — cancel gone digest + ZERO_ENDPOINT** (the false-positive envelope + cancel-domain reject)
12. **E10 / E8 — in-app order_update e2e + WS 2080** (observation channel)
13. **E2 / E3 — per-subaccount place bucket + 100-1000 real concurrency** (the scale gate)
14. **B16 / B17 / B18 — wrong chainId / sig-shape / fee** (remaining signing+fee codes)
15. **E15 / E16 / B15 — outage/geo + market-mode codes** (environment matrix, needs vendor triggers)

---

## 6. Safety note

🚨 **These are REAL orders on the live Ink testnet, signed by a funded in-tab wallet — they move (testnet) value and can open real positions.** Every case must be **operator-driven and confirmed** (typed-`RUN` + LIVE warning), never fired autonomously or in a loop without a human in the loop.

- Keep sizes **at/above minSize but minimal**; the min-notional is **100 USDT0** (`clampOrderSize` bumps up to clear it).
- **Prefer `post_only` maker at ~90% of mid** so cases *rest* (cancellable, no economic fill) rather than market-fill — this is the default for A-group, B-band, C-lifecycle, and all dedup (D) cases.
- Use a **taker/crossing IOC only where the fill itself is under test** (A3/A4/A7/A8, C6 partial), and always pair it with a `reduceOnly` **close (A10)** to leave the wallet flat.
- For dedup (D1-D4) use a **resting maker** so the "order" under resubmit is cancellable and never fills; cancel the survivor afterward.
- Scale cases (E3/E14) stay **testnet-only** until the mainnet EIP-712 + per-market verifyingContract re-validation gate (chainId 57073) is passed — **no mainnet capital** before that.
- Reconcile wallet balance/position to **clean** after each case; mass-cancel (kill switch) is the safety backstop.

---

## Coverage summary

GREEN offline (conformance, 🟡): EIP-712 byte-identity + ecrecover for place_order buy AND negative-amount sell, cancel_orders, withdraw_collateral, link_signer (24-order property test); appendix 513/1537/2561; validate.ts tick/step/min rounding; readiness; in-memory idempotency logic. GREEN live (✅): Phase 1b perp maker BUY + cancel + withdraw (strict signTypedData, no signDigest fallback) with live-observed rejects 2095/2007/2036/"Invalid address"; Phase 2 taker IOC buy + reduceOnly close + deposit-creates-subaccount + public fill stream + deposit/withdraw-from-UI; Phase 3a/3b per-EOA distinct sigs + out-of-range reject, in-memory jobId re-fire returns prior order, per-IP rate-limit calibrated (3/s clean, 5/s+ throttled, burst>=12; relay 16/16+10/10), Accept-Encoding WAF confirmed. STILL-OPEN live (🔴): the FIRST gap is a live standalone resting SELL maker (only ever done via close IOC) and ALL live SPOT placements (buy/sell, maker/taker) — every live proof to date is perp; spot has never been fired live and may or may not reuse the perp path. Then: the entire dedup triad 2013/2011/2004 (SDK-derived only, never fired live) on which the no-double-place guarantee hinges; every deliberate reject code beyond the 4 seen (insufficient collateral, below-min, unaligned tick/step, post-only-would-cross, wrong chainId, sig-shape, fee 2135, reduceOnly-misuse 2064/2067, market-mode 2069/2117/2119/2122/2070/2071, outage/geo 1xxx); lifecycle (partial fills, replace [unreachable gap], flip, cancel-gone-digest false-positive envelope); scale/env (per-subaccount place bucket verifiedOnTestnet:false, 100-1000 real concurrency on one egress IP, WS 2080, in-app order_update e2e, clock-skew with ClockSync unwired). NOT-WIRED (⚙️, test=confirm gap): isolated margin, leverage, triggers tp/sl/twap, STP, builder fee, market-kind input, atomic replace, FOK/GTT (silently collapse to default(1) — confirmed in execute.ts execTypeFor).


## Priority order (close the live gap first)

1. A5 — live SPOT maker BUY (first-ever spot placement; proves spot reuses the perp signing path)
2. A6 — live SPOT maker SELL
3. A2 — live perp resting SELL maker (standalone, not via close; confirms mid×1.1 rests in band)
4. A7/A8 — live spot taker BUY/SELL IOC (complete the spot happy-path grid)
5. D1 — byte-identical resubmit → 2013 (the #1 dedup proof, no-double-place guarantee)
6. D2 — stale resubmit → 2011; D3 — expired → 2004 (complete the dedup triad)
7. D4 — changed-field resubmit double-places (negative control for D1)
8. B13/B14 — insufficient collateral / pre-deposit reject (capture real engine codes)
9. B9/B7/B10/B11 — post-only-would-cross, below-min, unaligned tick/step (pin the 4 masked reject codes)
10. C6 — partial fill (deep-enough book; validates partial mapping + cancel-remainder)
11. C2/C12 — cancel gone digest (false-positive envelope) + ZERO_ENDPOINT cancel-domain reject
12. E10/E8 — in-app order_update e2e + WS 2080 compression
13. E2/E3 — per-subaccount place bucket + 100-1000 real concurrency (scale gate)
14. B16/B17/B18 — wrong chainId 2093 / sig-shape 2027-2035 / fee 2135
15. E15/E16/B15 — outage+geo 1xxx + market-mode codes (needs vendor triggers)


_Total enumerated test cases: 66. Design produced by a multi-agent ultracode workflow (4 factor-enumerators + 1 synthesizer), grounded in adapter-nado/liveContext + the Phase 1a/1b live findings + project memories. Design only — no live orders placed._
