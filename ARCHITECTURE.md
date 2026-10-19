# Nado Trading Desk — Framework Architecture (v2)

**A generic, multi-protocol, multi-wallet automation framework. Nado is the first pluggable adapter.**

_Date: 2026-10-16 · Status: adopted. Seam v2 produced by a 2-design → 4-onboarding-stress-test → synthesis workflow and proven against generic approve+call, Nado CLOB, an Aave-style lender, and a Uniswap-style AMM. The seam is implemented in [`packages/adapter-api/src/index.ts`](packages/adapter-api/src/index.ts)._

---

## The one sentence
A **protocol-agnostic core** (custody, chain primitives, scheduler, rate-limiter, automation, reconcile/alerting) talks to every venue through **one seam**: a tiny **universal `ProtocolPort`** + **opt-in capability sub-interfaces** (Trading / Lending / Swap…) + a declarative, closed-but-extensible **`ProtocolManifest`** — and a separate **chain-level primitives** layer (`ContractCall` / `sign→send`) that needs no adapter at all. Core speaks decimal strings + a closed vocabulary; all protocol-isms stay in the adapter behind `.raw`.

## Design principle: configurability-first (D7/D8)
The framework exposes **flexible protocol-interaction tools + rich typed settings**, never built-in alpha. The product is: **primitives** (basic trading · smart-contract interaction · sign→send) + **bulk automation** ("massive manipulation") across 1000+ wallets, with every knob — frequency/cadence, ranges, schedules, limits — declared as **data** the UI renders automatically. No strategy engine, no math (EV/sizing), no profiling/analytics; monitoring **displays** protocol/chain-reported state only.

## Governance — keeps n=1 honest (mechanized)
1. **Promotion rule:** a vocabulary member is frozen/mutated only when a real adapter needs it (≥2-adapter rule for further mutation).
2. **`.raw` lint-ban:** `core`/`automation`/`ui` may not read or type-assert `.raw` — a `.raw` read in core is the build-failing signal to promote a typed member.
3. **Seam lint-ban:** `core`/`automation`/`ui` may not import a concrete `adapter-*`; only `apps/console` registers adapters.
4. **Conformance suite** (the over-abstraction detector): every adapter passes it unmodified, and it now also asserts `supportedOps` matches the `execute()` variants, that an absent capability means an absent sub-object (**never a stub-throw**), and that subaccount-optionality round-trips.

---

## Module layout (v2)
pnpm + Turborepo monorepo; one-way, compile-enforced dependency graph.

```
packages/
  adapter-api/   THE SEAM (types + two pure helpers CHAIN_LEVEL / accountKey). Universal ProtocolPort +
                 capability sub-interfaces, ChainPrimitives, ChainRegistry/ChainSpec, Operation union +
                 ActionTemplate, ProtocolManifest + SettingsSpec, AdapterError, WalletSigner, the two nonce
                 sources, ExecutionPlan/PlanStep, and the security display/label types.
  core/
    custody/     Wative wrapper (2.6.0 + IdbProviderV3); chain-neutral WalletSigner.
    chain/       owns the ChainRegistry (WativeChainRegistry) + implements ChainPrimitives: prepareChainCall /
                 prepareRawTx (→ ExecutionPlan on the shared on-chain nonce lane), readCall (signer-less
                 eth_call for quotes/reserves/views), getNativeBalance / getErc20Balances (adapter-free
                 balance display), decode (core-side WYSIWYS), revokeApprovalOp. Generic approve+call, NO adapter.
    plan/        the KIND-AGNOSTIC dispatch + ExecutionPlan runner: chainCall|rawTx →
                 ChainPrimitives; else → the adapter's execute(ctx, op). Bounded broadcast-retry branched on
                 ChainSpec.broadcast + AdapterError category. A new interaction KIND never edits a core router.
    automation/  the ActionTemplate engine ("massive manipulation"): resolve TargetSelection → WalletId[],
                 per-wallet range jitter, onFailure, schedule; enforces optional SpendCapPolicy before signing.
    scheduler/   in-tab, IndexedDB-persisted, per-wallet serialized lane, priority, KILL SWITCH, resume.
    spendcaps/   optional SpendCapPolicy evaluation (per-op / wallet / cohort / window USD, max blast radius).
    ratelimit/   token buckets from manifest.rateLimits AND ChainSpec.rateLimits (per-chain RPC);
                 ip buckets are process-global singletons (one egress IP, D3).
    reconcile/   per-data-kind stream|poll|reconcile (adapter-declared) → normalized store; the drift path.
    alerting/    threshold / drift alerts over reconciled state (display only).
    clocksync/   server-time skew tracking for nonce / stream-auth (scaffold; not yet wired into the app).
    transport/   MeteredTransport (pooled sockets) — every call (incl. chainCall/rawTx/readCall) metered.
  adapter-sdk/       the CONFORMANCE SUITE (optional helpers; core doesn't depend on it).
  adapter-nado/      the first adapter (@nadohq/client + Wative viem bridge).
  adapter-stub-lend/ a second, lending-kind STUB adapter — the genericity proof that a new kind is bounded-additive.
  ui/                headless VIEW-MODEL (pure; no React/Kumo): renderActionForm from SettingsSpec, readiness,
                     fleet / accounting / filter logic. apps/console composes it into the React shell.
apps/console/        the Next.js + Kumo + Tailwind shell; the only module importing concrete adapters + wiring RPC.
```
🔻 **`core/strategy/` is DELETED** — no strategy engine, no-self-cross guard, auto-reduce, EV/points math (D7/D8). RD4 ("CLOB-scoped; refuse non-CLOB") is retired. **`core/chain/`** is what makes generic approve+call adapter-free.

---

## Core vs. adapter (v2)

| Concern | CORE | ADAPTER |
|---|---|---|
| Universal port | `ProtocolPort`: init/dispose, costOf, resolveAccount, getBalances, subscribe, `execute<O>`/preview/supports, normalizeError, labelOperation, `capability<K>()`, optional funding/subaccount/rewards | implements it; **trading lives only in `TradingCapability`** — non-trading adapters implement no order methods and **stub-throw nothing** |
| Chain primitives | `core/chain` implements `ChainPrimitives` (contract-call, raw tx, readCall, balances, decode, revoke) over the registry — **no adapter needed** | — (a generic approve+call "protocol" is pure chain-level) |
| Numeric format | decimal strings + branded `Amount` | priceX18/u64/lamport scaling, tick/step rounding |
| Account model | `AccountHandle` keyed by (protocolId?, chainId); both optional; `WalletComposite` across protocols/chains | bytes32 subaccounts etc. in `.raw` |
| Readiness | adapter-declared ordered states (`manifest.account.readinessStates`) | Nado's 3-state lifecycle (`unfunded`/`funded`/`ready`) lives in Nado's manifest |
| Nonces | ONE shared `OnChainNonceSource` per (wallet,chain) for all on-chain producers | protocol order-nonce (timestamp uint64) via `ProtocolNonceSource` |
| Errors | normalized `AdapterError{category,retrySafe,…}`; retry branches only on these | maps its codes into `AdapterError` |
| Settings/UI | typed `SettingsSpec` → `renderActionForm`, zero per-protocol branching | declares its knobs as manifest data |
| Automation | `ActionTemplate` engine, scheduler, rate-limiter, optional spend caps | — |
| Monitoring | stream/poll per adapter declaration; cohort-aware auth-stream budget; display only | supplies normalized reported values |
| Security | WYSIWYS decode (chain ops), labels, warnings, optional caps — all non-blocking | asserts previews for protocol executes (`decodedByCore:false`) |
| Escape hatch | lint-banned from `.raw` | owns `.raw` everywhere |

---

## The seam v2 (condensed — full interface in `packages/adapter-api/src/index.ts`)

```ts
// UNITS — decimal strings; adapter owns all fixed-point scaling. No PriceX18 in the domain.
type Decimal = string & {__decimal:unique symbol};  type Amount = string & {__amount:unique symbol};
type ChainId = number | string;  type Address = {family:'evm';value:`0x${string}`}|{family:'svm';value:string};

// [#3] CHAIN REGISTRY (core-owned): (chainId/family) → rpc(read/broadcast) / nativeAsset / gasModel /
//      broadcast policy / per-chain RPC rateLimits. ChainSpec.hidden covers Solana (deferred).
interface ChainRegistry { get(id):ChainSpec|undefined; require(id):ChainSpec; byFamily(f):ChainSpec[]; list():ChainSpec[]; all():ChainSpec[] }

// [#1] UNIVERSAL PORT — tiny, trading-free. Any protocol (or none) satisfies it without stub-throws.
interface ProtocolPort {
  readonly manifest: ProtocolManifest;
  init(env:AdapterEnv):Promise<void>; dispose():Promise<void>;
  costOf(op:AdapterOp):RateCost[];
  resolveAccount(a:{owner:Address;chainId:ChainId;subaccountName?:string}):Promise<AccountHandle>;
  getBalances(a:AccountHandle):Promise<Balance[]>;
  subscribe(targets:AccountHandle[], kinds:DataKind[], sink:StreamSink):Subscription;
  execute<O extends ProtocolOperation>(ctx:SignerContext, op:O):Promise<OpResult<O>>; // adapter dispatches on op.kind
  preview(ctx:SignerContext, op:ProtocolOperation):Promise<SignedPayloadPreview>;      // decodedByCore:false
  labelOperation(op:ProtocolOperation):SafetyLabel;
  normalizeError(e:unknown):AdapterError;
  capability<K extends CapabilityId>(id:K):CapabilityMap[K]|undefined;
  // optional builders (ExecutionPlan, NOT Operation variants → union stays serializable):
  prepareDeposit?(ctx,req):Promise<ExecutionPlan>; prepareWithdraw?(ctx,req):Promise<ExecutionPlan>;
  ensureSubaccount?(ctx,name?):Promise<ExecutionPlan>; provisionDelegatedSigner?(ctx,hot):Promise<ExecutionPlan>;
  getRewards?(a:AccountHandle):Promise<RewardsSnapshot>;
}
interface ProtocolAdapter extends ProtocolPort { /* exposes implemented CapabilityMap entries */ }

// [#1] CAPABILITY SUB-INTERFACES (opt-in). Order methods exist ONLY here.
interface CapabilityMap { trading:TradingCapability; lending:LendingCapability; swap:SwapCapability /*reserved*/ }
interface TradingCapability { getMarkets(); getOrderBook(m); getPositions(a); getOpenOrders(a); getFills(a,since?);
  normalizeOrder(i,m); placeOrder(ctx,i); cancelOrders(ctx,c); replaceOrder?(ctx,r) }        // thin wrappers over execute
interface LendingCapability { getReserves(); getLendingPositions(a); supply(ctx,i); borrow(ctx,i); repay(ctx,i); withdrawSupply(ctx,i) } // frozen (new kind, n=1)

// [#2] CHAIN-LEVEL PRIMITIVES (core/chain) — usable with NO ProtocolPort.
interface ChainPrimitives {
  resolveChainAccount(a:{owner:Address;chainId:ChainId}):Promise<AccountHandle>; // protocolId undefined, no readiness
  getNativeBalance(a); getErc20Balances(a, tokens);
  readCall(chainId, call):Promise<unknown>;                       // signer-less eth_call (quotes/reserves/views)
  prepareChainCall(ctx, input:ChainCallInput):Promise<ExecutionPlan>;
  prepareRawTx(ctx, input:RawTxInput):Promise<ExecutionPlan>;
  decode(chainId, to, data, abi?):SignedPayloadPreview;           // core-side WYSIWYS, decodedByCore:true
  revokeApprovalOp(chainId, token, spender):ChainCallInput;       // evacuate helper (approve(spender,0))
}

// [#6] UNIFIED, SERIALIZABLE OPERATION UNION + ACTION TEMPLATE (the bulk-automation product).
type ProtocolOperation =
  | {kind:'placeOrder';input:PlaceOrderInput} | {kind:'cancel';input:CancelInput} | {kind:'replace';input:ReplaceInput}
  | {kind:'supply'|'borrow'|'repay'|'withdrawSupply';input:…}     // lending (new kind)
  | {kind:'chainCall';input:ChainCallInput} | {kind:'rawTx';input:RawTxInput};  // chain-level (protocolId undefined)
interface ActionTemplate { id; version; steps:ActionStepTemplate[]; schedule?:ScheduleSpec; target:TargetSelection;
  onFailure:'stop'|'continue'; stopOnFleetError?:boolean; caps?:SpendCapPolicy }  // steps carry per-field NumberRange jitter

// [#5] SETTINGS SCHEMA — the generic UI surface (pure manifest data).
interface ParamSchema { id; label; kind:'number'|'range'|'enum'|'bool'|'duration'|'address'|'token'|'decimal'|'text';
  unit?; min?; max?; step?; default?; options?; capabilityGate?:CapabilityId; help? }

// [#9] NORMALIZED ERROR · [#10] NONCES · [#14] SECURITY
interface AdapterError { category:'retryable-safe'|'retryable-unsafe'|'rejected'|'rate-limited'|'auth'|'network'; retrySafe:boolean; message; code?; retryAfterMs?; raw }
interface OnChainNonceSource { lease(walletId, chainId):Promise<number> }   interface ProtocolNonceSource { timestamp():bigint; next(walletId):Promise<number> }
type SafetyLabel = { destructive?; grantsStandingAuth?; movesFunds?; requiresPrimaryKey?; blastRadiusClass:'none'|'trading'|'approval'|'funds-move'|'account-control'; dangerousSelectors?:string[] }
interface SignedPayloadPreview { decodedByCore:boolean; summary; fields; label:SafetyLabel; warnings:SecurityWarning[] }
interface SpendCapPolicy { enabled:boolean; perOpUsd?; perWalletWindowUsd?; perCohortUsd?; globalWindowUsd?; maxBlastRadius?; allowanceCapNative? } // off by default
```
Domain types (`Order`/`Position`/`Balance`/`Fill`/`LendingReserve`/`LendingPosition`) all carry optional `subaccount?` and a `.raw` valve; **no core-computed fields** (`liquidationPrice`/`healthFactor`/`APY` are adapter-reported only). Monitoring extends `NormalizedEvent` with `tx_status`/`lending`/`market_data` so polled state reaches the store.

---

## The 14 seam-v2 changes (vs v1)
| # | Change |
|---|---|
| 1 | Split the monolith → tiny universal port + opt-in capability sub-interfaces; order methods live only in `TradingCapability`; **no stub-throws** |
| 2 | New **chain-level primitives** (contract-call / sign→send / readCall / balances / decode / revoke) usable with no adapter |
| 3 | New **ChainRegistry/ChainSpec** incl. per-chain RPC rate limits (one-egress-IP metering) |
| 4 | Concurrent model: `AccountHandle` keyed by (protocolId?, chainId), both optional; `WalletComposite` |
| 5 | New typed **SettingsSpec/ParamSchema** → auto-rendered forms |
| 6 | New serializable **Operation union + ActionTemplate** (ranges, onFailure, schedule, import/export) |
| 7 | `subaccount?` optional across domain + inputs |
| 8 | Readiness **adapter-declared**, not a core enum |
| 9 | Normalized **AdapterError** taxonomy |
| 10 | Nonce split: one shared on-chain lane + separate protocol order-nonce |
| 11 | Monitor: adapter-declared stream/poll per data kind; cohort-aware **AuthStreamBudget** allocator (replaces the guard) |
| 12 | **Purged**: no-self-cross guard, auto-reduce, strategy engine/RD4, renderStrategyForm; STP/triggers are pass-through flags |
| 13 | **No core-computed fields**; typed `LendingReserve`/`LendingPosition` so lending display avoids the `.raw` ban |
| 14 | Security: `SafetyLabel`/`SignedPayloadPreview`(`decodedByCore`)/warnings/optional `SpendCapPolicy` — all non-blocking |

---

## Security model (permissive — A2)
Warnings only; operators own the risk; adapters are **trusted curated code** (no sandbox). Four layers:
1. **WYSIWYS display** — chain ops are decoded **core-side** (`decodedByCore:true`, independent guarantee); protocol executes carry an **adapter-asserted** preview (`decodedByCore:false`, honest trust-asymmetry — acceptable only because adapters are trusted).
2. **Typed safety labels** — `destructive`/`grantsStandingAuth`(approve/link_signer/setApprovalForAll)/`movesFunds`/`requiresPrimaryKey`/`blastRadiusClass` → drive **warnings**, never block. The main key may sign generic calls gated only by the confirm hook.
3. **Confirm hook** — per-op yes/no on the preview (permissive by default).
4. **Optional config caps** (`SpendCapPolicy`, off by default) — the only place security *bites*, enforced by scheduler/plan before signing (per-op/wallet/cohort/window USD, max blast radius, non-MAX allowance cap).
**Evacuate** (optional, operator-initiated): fan `approve(spender,0)` across the fleet via `revokeApprovalOp`, then withdraw (withdrawals still require the primary key). No core-computed safety metrics — drift/liquidation-distance/blast-radius are display/warn, derived transiently from reported values, never a gate.

---

## Genericity proof (the four onboarding stress-tests)
| Kind | Cost | How |
|---|---|---|
| **Generic approve+call** (A1, #2 target) | **Pure data, zero adapter code, zero core change** | `chainCall`/`rawTx` Operations (protocolId undefined) + one `ChainSpec` in the registry + an `ActionTemplate`; served entirely by `core/chain` + registry — no `ProtocolPort` touched |
| **Nado CLOB** (adapter #1) | **One adapter package + manifest; zero core surgery; zero stub-throw** | `implemented:['trading']`; EIP-712 executes via `execute`; bytes32/priceX18/appendix in `.raw`; readiness in its manifest |
| **Aave-style lending** (new kind, n=1) | **Bounded-additive**: one reviewed seam edit (the kind, already applied) + one adapter; no core-router edit, no stub-throw | `implemented:['lending']`; `TradingCapability` simply absent |
| **Uniswap-style AMM** | **Bounded-additive (smaller)**: one adapter; swap rides `chainCall` | poll monitor + `readCall` quotes + `slippageBps` setting; no first-class swap op until a 2nd AMM (A3 discipline) |

---

## Nado adapter (adapter #1)
`implemented:['trading']`. Manifest: account `{subaccounts:true, subaccountIdKind:'bytes32', delegatedSigner:true, withdrawalRequiresPrimary:true, createsOnFirstDeposit:true, readinessStates:[unfunded→funded→ready]}`; signing `{evm, eip712-strict, chainId:57073, verifyingContract:'per-market', digestFallback:true}`; rateLimits query/edge/archive/execute(wallet)/ws(ip-conn); streams fills+position_change (unauth, multiplexed) + order_update (per-wallet auth, ≤5/wallet, scarce). `execute` dispatches place/cancel/replace to EIP-712 protocol-execute plan steps (adapter preview + fallbackDigest); `prepareDeposit` = approve USDT0 + deposit_collateral as **one plan** on the shared on-chain lane; `provisionDelegatedSigner` = link_signer signed by the main wallet; order nonce from `ProtocolNonceSource`. **New core members required: zero.**

---

## Wative is the on-chain engine — core delegates, never reinvents
🔧 `core/chain` and `core/plan` are **thin wrappers** over wative-core's on-chain layer, NOT reimplementations. Mapping (verified against the wative docs; re-confirm on 2.6.0):

| Seam / core need | Use wative-core |
|---|---|
| balances (native + ERC-20) | `ChainClient.readBalance(owner, token?)` · `EvmSigner.refreshBalances()` |
| contract-call (`chainCall`) | `new Contract(abi).call(evm, to, fn, args)` → `EvmTransaction` · `Contract.encode/decode` |
| sign→send / raw tx (`rawTx`) | `EvmSigner.buildTransaction({ to, data, value })`; **`signRawTransaction`** for foreign/dApp calldata |
| revoke approval (evacuate) | `ERC20.call(evm, token, 'approve', [spender, 0n])` |
| WYSIWYS decode / destination guard | `Contract.decode` · `EvmSigner.checkDestination` → `DestinationReport` |
| Nado deposit (approve + `depositCollateral`) | `ERC20.call` + an Endpoint `Contract.call`, as `onchain-tx` plan steps |
| broadcast + track | `EvmSigner.sendTransaction(tx)` → **`TransactionTracker`** (`whenConfirmed`, `change`/`confirmed`/`failed` events) |
| **AdapterError retry-safety** | tracker terminal status: `failed`→**retryable-safe**, `timeout`→**retryable-unsafe (look up by hash first)**, `dropped`→safe — wative already draws this exact line |
| on-chain nonce | `buildTransaction` auto-fills, **watermark-reconciled per (chain,sender)** so sequential sends don't collide; core adds only the per-wallet serialized lane for the bulk/concurrent case |
| simulate | `EvmSigner.simulateTransaction` · `ChainClient.simulate` |
| RPC cache shutdown | `closeAllRpcClients()` (process-global; separate from `Workspace.close()`) |
| EIP-712 execute signing | `WalletSigner.signTypedData` (wave 1a: byte-equal to the Nado SDK) → wrap in viem `toAccount()` for `@nadohq/client` (wative has no native viem account) |

**What core genuinely adds (not in wative):** the normalized seam types; **rate-limit metering** (Nado's per-IP budget); **AdapterError** normalization (wative codes + tracker status → categories); the per-wallet serialized scheduling lane; and the **Nado gateway/archive HTTP+WS client** (the off-chain sequencer API — *not* chain RPC, so `ChainClient` doesn't cover it). wative owns RPC, calldata, the tx lifecycle, nonce, gas/fees, and the destination guard — core must not duplicate any of it.

### Retro-audit corrections (2026-10-16) — reinventions removed / bounded

A full audit of the seam + the `chain-registry` draft against wative's `.d.ts` surface found and fixed these:

- **Chain registry wraps wative, is not rebuilt.** The draft `StaticChainRegistry` + `buildDefaultChainSpecs()` (hand-`Map` + hardcoded Ink 57073/explorer) is superseded. `core/chain`'s registry projects wative's **`Network` builtins (`Network.Ink` already exists) + `Workspace.networks` (`NetworkCollection`: `byChainId`/`bySlug`/`add`)** into the seam's `ChainSpec`, overlaying ONLY what wative lacks: `rateLimits`, the re-broadcast `BroadcastPolicy`, and `testnet`/`blockExplorerUrl` flags. No chain constants are hardcoded except Ink **testnet** (not a wative builtin) and the rate buckets.
- **`GasModel` dropped.** wative owns fees (`buildTransaction` autofill + `EvmTxBuildParams.maxFeePerGasCeiling`). The seam now carries only an optional `ChainSpec.fee` (`FeePolicy`: ceiling/tip hint forwarded to `buildTransaction`).
- **`SimulationResult` aligned** to wative's exported shape (`success`/`error`/`logs`/`returnData`/`gasUsed`/`raw`) + a core-only non-blocking `warnings` overlay, so `core/plan` maps it near-passthrough.

**Partial-delegation rules (keep the core-added part, delegate the mechanism):**

| Seam type | Core adds | Delegates the mechanism to |
|---|---|---|
| `OnChainNonceSource` | the per-wallet **serialized lease lane** (for concurrent bulk sends) | the nonce VALUE comes from `buildTransaction` watermark autofill; only `reconcile` reads `getTransactionCount` |
| `SignedPayloadPreview` | the `SafetyLabel` classification (destructive/grantsStandingAuth/movesFunds/blastRadius) | ABI/tx decode = `Contract.decode` + `DecodedTx`; destination screen = `checkDestination` → `DestinationReport` |
| `ChainPrimitives` balances | the normalized `Balance` view (available/scope/subaccount) | fetch = `ChainClient.readBalance` / `Address.refreshBalances` — never hand-rolled `balanceOf` |
| `UnsignedTx` / `TxReceiptView` / `SimulationResult` | serializable seam DTOs | map 1:1 to `EvmTxBuildParams` / `TransactionReceipt` / wative `SimulationResult` — no translation layer |

**AdapterError mapping is driven by `WativeErrorCode`** (not a parallel taxonomy): `TX_TIMEOUT`/`RPC_UNREACHABLE`→`retryable-unsafe` (reconcile-by-hash first); `TX_DROPPED`/`TX_BUILD_FAILED`/`TX_SIGN_FAILED`→`retryable-safe` (never landed); `RPC_REJECTED`/`TX_SUBMIT_FAILED`→`rejected`; `BAD_PASSWORD`/`WORKSPACE_LOCKED`/`ACCOUNT_LOCKED`/`PERMISSION_DENIED`→`auth`; `UNSUPPORTED_NETWORK`→`network`; plus tracker terminal status (`failed`→safe, `timeout`→unsafe, `dropped`→safe).

**Forward-looking (don't reinvent in later waves):** cohort membership + the sidebar Account filter ride wative **`Wallet` tags** (`addTag`/`hasTag`/`tags`) + `Workspace.filter(q, "Wallet"|"Account")`; the operator log uses wative **`Logger`**; the workspace-password UX uses **`PasswordPolicy`/`PasswordScore`**; mnemonic backup uses **`sealMnemonic`/`openMnemonic`/`newMnemonic`**; funding/consolidation transfers use **`buildTransferPayload`/`TransferRequest`**; gateway SIWE (if any) uses **`Address.signIn()`**.

## Remaining open (bounded, tracked)
- **Swap shape** stays reserved (rides `chainCall`) until a 2nd AMM justifies a first-class swap op (multi-hop/exactOut/permit2/native-wrap unmodeled).
- **Lending frozen at n=1** — a 2nd lender may force a bounded additive revision.
- **Adapter-asserted preview** (`decodedByCore:false`) for protocol executes is a residual trust surface, acceptable under trusted-adapters.
- **AuthStreamBudget policy** (strict-active vs weighted vs waitlist on cohort rotation) is scheduler config, not fixed in the seam.
- **Funding as an automation step** — deposit/withdraw are plan builders, not Operations, so a template can't yet interleave a funding step; a serializable funding-op wrapper is a bounded future addition.
- **RPC rate-cost calibration** — per-chain bucket capacities are placeholders (`verifiedOnTestnet:false`); measure against real Ink RPC + one egress IP, canary-guard before mainnet.
- **Attended-now/unattended-later** — the seam is signer-context-driven and makes no attended-tab assumption; the unattended helper's own control-plane security (M4/M5) is out of seam scope, still undecided.
