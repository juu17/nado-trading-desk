# Phase 0 foundation — the seams Phase A builds on

Phase 0 lands the four prerequisites that gate the Nado matching-engine capacity
benchmark. No live order flow is placed here — these are the sockets the Phase-A A/B
loop + `ExperimentConnector` plug into. The engine is a brute, high-density concurrent
maker/taker generator from **one** endpoint; "does this choice throttle trade density?"
was a first-class audit dimension throughout.

All paths below are repo-relative. The intern fork is referred to as *lucklab* (the
port source); the clean base is this repo.

## What landed

| Prereq | Where | What Phase A does with it |
|---|---|---|
| **P0-1** persisted `OperationsStore` | `packages/core/src/funding/{types,store}.ts` | Persist the desk state; write orders per wallet |
| **P0-2** multi-wallet gateway | `packages/adapter-nado/src/multi-wallet-gateway.ts` | One gateway view per wallet over a shared per-IP budget |
| **P0-3** order engine + journal | `packages/core/src/funding/{order-ledger,journal,wallet-use-plan}.ts` | The no-double-place kernel; inject the experiment admit guard |
| **P0-4** wiring seams | `packages/core/src/driver/*`, `apps/console/app/lib/fillHints.ts` | Drive `tick()`, wake pairs on fills, feed the clock |

## The seams

### Store — `OperationsStore` / `ShardedOperationsStore` (`funding/types.ts`, `funding/store.ts`)
- `OperationsStore = { read, update(fn) }` is the atomic serialized read-modify-write;
  `ShardedOperationsStore` adds `updateOwner(owner, fn)` — a **per-owner lane** so
  concurrent order writes for different wallets never serialize behind one global
  write-lock. `update` is the exclusive global lane (operator stop/enable/recover,
  group edits); same-owner writes serialize; different-owner writes run concurrently.
- `DeskOperations<C>` is trimmed to the benchmark subset and **generic over the
  campaign slot** `C` so Phase A uses `DeskOperations<ExperimentCampaign>` with **no
  core→experiment import**. Core never reads `experiments`.
- `InMemoryOperationsStore` (node) + `IdbOperationsStore` (browser; `nado-ika-custody`
  IDB). The hot path reads the global O(1) (InMemory shallow-shares it; IDB caches it);
  it is single-process by design (crash/observational/cross-tab consistency are Phase
  B/C hardening — see the in-code scope note).
- Owner-lane writes may touch only that owner's `orders`; a scalar OR nested-reassign
  global write on the owner lane refuses `OPERATIONS_GLOBAL_WRITE_ON_OWNER_LANE`, and a
  foreign-owner order refuses `OPERATIONS_SHARD_ESCAPE`.

### Order engine — `OrderLedger` (`funding/order-ledger.ts`)
- The single-dispatch, no-double-place kernel, ported faithfully from lucklab 1.4.3.
  Its ported fault-path tests pass **unchanged** (behaviour preserved).
- **`admit` hook** (`OrderAdmission<C>`, default no-op) replaces the cut circular
  `experiment/guards` import. **Phase A MUST inject** `experiment/guards`'
  `assertExperimentOrderAdmission` so ordinary writes can't borrow an experiment's
  wallet/identity. The hook runs on the **per-owner view** and must stay **read-only on
  global fields** (it may read `s.experiments`; a nested-global write is refused by the
  store guard above).
- **Per-wallet admission gate:** the global scan that capped concurrent in-flight
  orders at 1 is re-scoped to the order's owner — N wallets keep N concurrent in-flight
  dispatches on the happy path. `ProtectedOrderConnector = { dispatch, lookup }` is the
  seam Phase A's base-native `ExperimentConnector` implements against adapter-nado
  (post_only/ioc/reduceOnly via `adapter-nado/src/execute.ts`).
- **chainId** is a required plain number (adapter supplies Ink's value); no Ink pinning
  in core.
- **Invariant:** order `id` must be **globally unique** (namespace by wallet/campaign).
  The per-owner prior-by-id lookup + `reconcile(id)` rely on it; `journal.ts` is the
  fail-closed backstop (a cross-owner id dup → `JOURNAL_DAMAGED` on load).

### Multi-wallet gateway — `createMultiWalletNadoGateway` (`adapter-nado/src/multi-wallet-gateway.ts`)
- `forOwner(owner)` → a memoized `NadoGateway` view; every view shares **one**
  transport + limiter + engine, so the whole cohort's reads **and** writes draw on a
  **single per-IP budget** (single-IP egress; no multi-worker plumbing). Reads bind the
  per-view owner; writes carry their own `signed.sender`.
- **Keyless-engine precondition:** sharing one `EngineClient` is safe only because it
  holds no signer — keep it keyless.
- On-chain nonce serialization (funding, deferred) reuses core's `SerialNonceLane` at
  the composition root; the off-chain order path needs none.

### Wiring — `core/src/driver/*` + the console bridge
- `TickDriver.tick(id?)` (coordinator implements it) driven by `DriverLoop` (interval
  backstop; a throwing tick is reported, not fatal).
- `NudgeSink.nudge(campaignId, pairId)` (coordinator implements it) + `FillHintRouter`
  + `InMemoryFillHintRegistry` (**subaccount→{campaign,pair}** static map): a wallet
  fill wakes its pair. `onFill` never throws (sync + async) and reports via
  `onNudgeError`.
- `ClockSource = () => number`, fed from `ClockSync` via `clockSourceFromSync` → inject
  into the order nonce/expiration path + the coordinator's `now`.
- `apps/console/app/lib/fillHints.ts#connectFillHints` wires a wallet's authed
  `order_update` WS → the router (owner = the connection's subaccount).

## Phase-A contracts (get these right or the measured numbers lie)
1. **Keep order emission on the nudge/dispatch path, not inside periodic `tick()`** — a
   fixed inter-tick gap would throttle max-throughput by construction.
2. **Keep `nudge`'s synchronous prefix cheap** (set a flag / enqueue) — it runs inline
   on the WS `onmessage`. Make `nudge` **idempotent** (the router does no de-dup).
3. **Connector timeout classification is the single highest-leverage factor.** A
   transport/load timeout surfaces as `KnownOrderNotSent` (no halt — one order rejected
   on the owner lane) or a generic throw → `ORDER_RESULT_UNKNOWN` → the **global** desk
   halt. The adapter MUST aggressively classify "never crossed transport" (pre-send
   abort, TCP-level failure, the known Cloudflare `Accept-Encoding`/WAF 403) as
   `KnownOrderNotSent`. One sub-saturation transient mapped to UNKNOWN kills a clean run
   early and under-reports capacity.
4. **A global halt is a run-TERMINATING event** (Phase B): report "sustained fills/sec
   up to the first halt"; never count zeros past it. `enable()` recovery is
   operator-gated.
5. **Label the Phase-0 density claim precisely:** "clean-path, single-in-flight-per-
   wallet, up to first ambiguous fault" — not "sustained density through faults."
6. **Inject the real `admit` guard** before any experiment goes live; keep it read-only
   on globals.

## Open design decision for the operator (surfaced, not decided)
**Fill-hint wake transport.** P0-4 names the authed `order_update` WS (per the task),
but it emits placed/cancelled/filled, so the bridge **over-nudges** (a wake per order
placement), each spurious wake costing one read against a tight single-IP budget. The
intern's own wake path used Nado's **keyless public `fill` stream** — fill-only,
multiplexed across the whole working set, no per-wallet auth — a better fit for the read
budget + single-IP. The core seam is **subaccount-keyed precisely so the transport can
be swapped with no engine change.** Recommendation: adopt the public `fill` stream in
Phase A. Confirm before Phase A wires the live wake path.

## Deferred (grounded in the locked decisions; not gaps)
- **`direct.ts` + `network-store.ts`** (named in the PATCH-1 file list) are **not**
  order-path foundation — nothing in the order path imports them; `direct.ts` pulls in
  the "leave-behind" `funding/executor.js` + a `diagnostics/` module absent here, and
  `network-store.ts` hardcodes Ink chain-ids over dropped fields. Funding is Phase C;
  multi-network partitioning isn't needed for one-network-per-run. Port de-Inked/trimmed
  versions when Phase A/C ports `experiment/guards` (needs `depositReady`) or
  multi-network.
- **Per-wallet halt on a genuine fault.** An UNKNOWN/lookup-failure/mismatch/fatal still
  trips the **global** `tradingStopped` (preserved from the port). Its per-wallet form
  is entangled with the coordinator's recovery (Phase A), so it is deliberately left for
  Phase A rather than re-invented without its consumer.
- **IDB single-store txn serialization** and the read-budget **"28"** — both deferred:
  the current `nado:rest` budget is ~2/s (6 per 3s; the "28" is an unapplied PATCH-1
  item for Phase B), far below where IndexedDB same-store serialization bites. `onboarding`
  / `treasury` / `collateral` / hedge / HD-wallet fields are dropped (Phase C).
