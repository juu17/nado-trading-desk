// =============================================================================
// @farm/adapter-api  v2 — THE SEAM (types + two pure, side-effect-free helpers:
// CHAIN_LEVEL and accountKey(); no I/O, no imports outside type positions).
// Synthesis of candidate 1 (minimal universal port + opt-in capability
// sub-interfaces) and candidate 2 (unified serializable Operation union +
// generic execute<O> dispatch), with every stress-test leak closed.
//
// GRAFT DECISIONS
//  - UNIVERSAL ProtocolPort is tiny and trading-free -> Nado/lending/AMM satisfy
//    it with ZERO stub-throwing order methods (F1/Q3).  [#1]
//  - A generic `execute<O extends ProtocolOperation>` on the port is DISPATCHED
//    INSIDE the adapter (candidate 2's spine). core/actions routes only on
//    "chain-level op -> ChainPrimitives; else -> port.execute" — kind-agnostic,
//    so a NEW interaction kind (lending) adds Operation variants + a capability
//    + the adapter's own switch, and never edits a core per-kind router.
//  - capability<K>() returns typed read/write sub-interfaces (ergonomic + typed);
//    their write methods are thin wrappers that build an Operation and call
//    execute. Automation fans out over execute(op) directly.
//  - deposit/withdraw/ensureSubaccount/provisionDelegatedSigner stay ExecutionPlan
//    BUILDERS (not Operation variants): keeps the Operation union fully
//    SERIALIZABLE (no WalletSigner/functions smuggled into ActionTemplate) and
//    lets a 2-tx deposit (approve+deposit) be one plan, not one receipt.
//  - contract-call + sign->send are CHAIN-LEVEL: a core-owned ChainPrimitives
//    port over the ChainRegistry, usable with NO ProtocolPort (A1).  [#2]
//
// Tags [#1]..[#14] mark the 14 required seam-v2 changes.
// =============================================================================

// -----------------------------------------------------------------------------
// UNITS — kept from v1. Amounts are DECIMAL STRINGS; the adapter owns ALL
// fixed-point scaling (X18 / u64 / lamports). No PriceX18 ever enters the domain.
// -----------------------------------------------------------------------------
export type Decimal = string & { readonly __decimal: unique symbol }; // price / size
export type Amount  = string & { readonly __amount: unique symbol };  // token quantity
export type Usd     = number & { readonly __usd: unique symbol };
export type Bps     = number & { readonly __bps: unique symbol };
export type Hex     = `0x${string}`;

export type ChainFamily = 'evm' | 'svm';
// Numeric for EVM; svm uses a registry-assigned string key (modeled, hidden).
export type ChainId = number | string;
export type Address =
  | { family: 'evm'; value: Hex }
  | { family: 'svm'; value: string };
export type MarketId = string; // adapter-namespaced, e.g. "nado:perp:BTC-PERP"
export type WalletId = string; // core-owned custody-derived wallet handle

// -----------------------------------------------------------------------------
// [#3] CHAIN REGISTRY — core-owned. (chainId / family) -> rpc / native asset /
// gas model / broadcast policy / RPC RATE LIMITS. Consumed by BOTH adapters
// (via AdapterEnv.chains) and core/chain's ChainPrimitives. (A4/F21)
// NOTE the rateLimits field: it closes the kind-1 "1000 wallets, one RPC, one
// egress IP, no declared bucket" metering leak the stress-test found.
// -----------------------------------------------------------------------------
// [#3-audit] GasModel REMOVED — wative owns fee logic: `buildTransaction` auto-fills
// gas (EIP-1559 / legacy / L2 op-stack / svm-fee) and `EvmTxBuildParams` accepts a
// `maxFeePerGasCeiling`. Core never models gas; it forwards at most an optional
// ceiling/tip hint via ChainSpec.fee below.
export interface FeePolicy {
  maxFeePerGasCeilingGwei?: number; // -> wative buildTransaction maxFeePerGasCeiling
  priorityFeeGwei?: number;         // optional tip hint; wative fills the rest
}

export interface BroadcastPolicy {
  singleAttempt: boolean;     // wative ChainClient broadcast is single-attempt
  maxReattempts: number;      // the core plan runner owns bounded re-broadcast
  confirmations: number;
  lookupBeforeRetry: boolean; // retryable-unsafe => reconcile by hash FIRST
}
export interface ChainSpec {
  chainId: ChainId;
  family: ChainFamily;
  displayName: string;
  hidden?: boolean;                                   // e.g. Solana deferred (A4)
  nativeAsset: { symbol: string; decimals: number };
  rpc: { read: readonly string[]; broadcast: readonly string[] }; // split read/broadcast
  fee?: FeePolicy;                 // [#3-audit] wative owns gas; optional ceiling only
  broadcast: BroadcastPolicy;
  rateLimits: readonly RateLimitSpec[]; // [#3-fix] per-chain RPC buckets (RateScope 'chain')
  blockExplorerUrl?: string;
  testnet?: boolean;
}
export interface ChainRegistry {
  get(id: ChainId): ChainSpec | undefined;
  require(id: ChainId): ChainSpec;          // throws a normalized AdapterError(category:'network')
  has(id: ChainId): boolean;
  byFamily(family: ChainFamily): readonly ChainSpec[];
  list(): readonly ChainSpec[];             // non-hidden
  all(): readonly ChainSpec[];              // incl. hidden
}

// -----------------------------------------------------------------------------
// DECLARATION VOCABULARY — closed, core-owned, EXTENSIBLE via the promotion rule
// (>=2 adapters) + the `.raw` leak valve + `.raw` lint-ban. (A3)
// -----------------------------------------------------------------------------
export type ProductKind    = 'spot' | 'perp';
export type OrderKind      = 'limit' | 'market';
export type OrderRole      = 'maker' | 'taker' | 'unknown';
export type Tif            = 'gtc' | 'ioc' | 'fok' | 'gtt';
export type MarginMode     = 'isolated' | 'cross';
export type Microstructure = 'clob' | 'amm' | 'rfq';
// [#12] selfTradePrevention + triggers are PASS-THROUGH capability flags ONLY.
// The core neither interprets nor enforces them (the no-self-cross guard is gone).
export type StpMode     = 'none' | 'cancel-oldest' | 'cancel-newest' | 'cancel-both';
export type TriggerKind = 'tp' | 'sl' | 'twap';

// [#1] CAPABILITY MAP — the opt-in sub-interfaces an adapter MAY implement.
// Reserved slots are present so the map is total; a slot's SHAPE is frozen only
// when a real adapter justifies it (A3 promotion). `lending` is frozen NOW
// because the lender stress-test is a genuinely new KIND at n=1 (>=1 concrete
// adapter + the >=2-adapter rule applies to further mutation, not first freeze).
export interface CapabilityMap {
  trading: TradingCapability;
  lending: LendingCapability; // frozen (new-kind onboarding)
  swap: SwapCapability;       // reserved — swap rides chainCall until a 2nd AMM (A3)
}
export type CapabilityId = keyof CapabilityMap;

// -----------------------------------------------------------------------------
// [#5] SETTINGS / PARAM SCHEMA — the GENERIC PRODUCT SURFACE. The manifest
// declares typed param schemas; renderActionForm consumes them with zero
// per-protocol branching. New knob = pure manifest DATA; a new
// KIND of control = a reviewed member here. (Q4/F9)
// -----------------------------------------------------------------------------
export type ParamKind =
  | 'number' | 'range' | 'enum' | 'bool' | 'duration'
  | 'address' | 'token' | 'decimal' | 'text';
export interface ParamOption { value: string; label: string; }
export interface ParamSchema {
  id: string;                 // stable key written into the stored settings object
  label: string;
  kind: ParamKind;
  unit?: string;              // 'ms' | 'USDT0' | 'bps' | ...
  min?: number; max?: number; step?: number;   // number/range/duration
  decMin?: Decimal; decMax?: Decimal;           // decimal
  default?: unknown;
  options?: readonly ParamOption[];             // enum
  capabilityGate?: CapabilityId;  // only surfaced when the adapter implements it
  chainId?: ChainId;              // token/address scoping hint
  family?: ChainFamily;           // address scoping hint
  group?: string;
  required?: boolean;
  help?: string;
}
export type SettingsSpec = readonly ParamSchema[];

// Values (and ranges for per-wallet jitter) a rendered form produces.
export type ParamValue = string | number | boolean;
export interface NumberRange { min: number; max: number; step?: number }
export type ParamBinding = ParamValue | NumberRange;

// -----------------------------------------------------------------------------
// SIGNING SPEC — kept from v1 (closed discriminated union). chain-neutral.
// -----------------------------------------------------------------------------
export type SigningSpec =
  | { family: 'evm'; scheme: 'eip712-strict'; chainId: number;
      verifyingContract: 'per-market' | 'fixed'; digestFallback: boolean }
  | { family: 'evm'; scheme: 'digest'; chainId: number }
  | { family: 'evm'; scheme: 'raw-tx'; chainId: number }   // plain on-chain tx (AMM/swap/approve)
  | { family: 'svm'; scheme: 'ed25519' }
  | { family: 'offchain'; scheme: 'hmac' | 'ecdsa-message' };

// -----------------------------------------------------------------------------
// [#8] READINESS — ADAPTER-DECLARED ordered state list. No baked Nado/Vertex
// lifecycle enum in core. Branded string keeps core protocol-neutral; the
// manifest publishes the ordered vocabulary and the UI renders a progress badge
// from it. Suggested protocol-neutral baseline: ['unfunded','funded','ready'].
// -----------------------------------------------------------------------------
export type ReadinessState = string & { readonly __readiness?: unique symbol };
export interface ReadinessStep { id: ReadinessState; label: string; terminalReady?: boolean }

export interface AccountModelSpec {
  subaccounts: boolean;
  subaccountIdKind?: 'bytes32' | 'pubkey' | 'string';
  delegatedSigner: boolean;
  withdrawalRequiresPrimary?: boolean;
  createsOnFirstDeposit?: boolean;
  minOpenUsd?: Usd;
  readinessStates: readonly ReadinessStep[]; // [#8] ORDERED, adapter-declared
}

// -----------------------------------------------------------------------------
// RATE LIMITS — kept from v1. RateScope gains 'chain' for chain-level RPC ops.
// -----------------------------------------------------------------------------
export type RateScope = 'ip' | 'wallet' | 'subaccount' | 'ip-conn' | 'key' | 'chain';
export interface RateLimitSpec {
  bucket: string; scope: RateScope; algo: 'token-bucket' | 'sliding-window';
  capacity: number; windowMs: number;
  burst?: { capacity: number; windowMs: number };
  verifiedOnTestnet?: boolean;
}

// -----------------------------------------------------------------------------
// [#11] MONITOR — per-data-kind streamable-vs-pollable (adapter-declared);
// EXTENSIBLE kind; scarce auth-stream budget rationed by a core ALLOCATOR that
// is now COHORT-AWARE (the no-self-cross guard that previously rationed it is
// REMOVED). (F20/Q17)
// -----------------------------------------------------------------------------
export type KnownDataKind =
  | 'fills' | 'position_change' | 'order_update' | 'book' | 'funding'
  | 'balance' | 'tx_status' | 'lending_position' | 'market_data';
// Open string keeps the vocabulary extensible without a core edit; known members
// stay discoverable for exhaustive UI switches.
export type DataKind = KnownDataKind | (string & { readonly __dataKind?: unique symbol });

export interface StreamDescriptor {
  kind: DataKind;
  auth: 'none' | 'per-wallet';
  multiplex: 'many-subjects-per-conn' | 'one-subject-per-conn';
  maxAuthConnsPerWallet?: number; // the scarce budget the allocator rations
  maxConnsPerIp?: number;
  scarce?: boolean;               // scarce auth kind => goes through the allocator
}
// Adapter declares, per data kind, HOW core sources it. (streamable-vs-pollable)
export interface MonitorSourceSpec {
  dataKind: DataKind;
  source: 'stream' | 'poll' | 'stream-with-poll-reconcile';
  pollIntervalMs?: number;        // meaningful when source involves 'poll'
}
// Core-owned allocator for scarce per-(wallet,kind) authenticated streams
// (e.g. order_update <= 5/wallet, biased to the ACTIVE cohort). Pure resource
// rationing — NO wash-trade / correctness coupling.
export interface AuthStreamBudget {
  request(walletId: WalletId, kind: DataKind, cohortId?: string): boolean; // true = slot granted
  release(walletId: WalletId, kind: DataKind): void;
  available(kind: DataKind, cohortId?: string): number;
}

// -----------------------------------------------------------------------------
// [#1] MANIFEST CAPABILITIES — universal facts on the manifest; opt-in capability
// DECLARATIONS nested and gated by `implemented`. A bare approve+call adapter
// (or none at all) sets implemented: [].
// -----------------------------------------------------------------------------
export interface TradingCapabilityDecl {
  products: ProductKind[];
  orderKinds: OrderKind[];                 // 'limit'+postOnly => maker; 'market'/IOC => taker
  postOnly: boolean; reduceOnly: boolean; batchReplace: boolean;
  selfTradePrevention: StpMode[];          // [#12] pass-through flag only
  triggers: TriggerKind[];                 // [#12] pass-through flag only
  marketMicrostructure: Microstructure[];  // DISPLAY only — never gates (no "refuse non-CLOB")
  perp?: { marginModes: MarginMode[] };
}
export interface LendingCapabilityDecl { markets: string[]; canBorrow: boolean; canRepay: boolean }
export interface SwapCapabilityDecl   { venues: string[]; slippageConfigurable: boolean }
export interface ManifestCapabilities {
  implemented: readonly CapabilityId[];    // which sub-interfaces capability<K>() returns
  trading?: TradingCapabilityDecl;
  lending?: LendingCapabilityDecl;
  swap?: SwapCapabilityDecl;
  rewards: boolean;                        // DISPLAY of adapter-reported points only
}

export interface ProtocolManifest {
  id: string;
  displayName: string;
  version: number;
  chains: readonly ChainId[];              // references the chain registry (A4 multi-chain)
  capabilities: ManifestCapabilities;      // [#1] opt-in capability declarations
  account: AccountModelSpec;               // [#8] incl. declared readinessStates
  signing: SigningSpec;
  rateLimits: readonly RateLimitSpec[];     // protocol-service buckets
  streams: readonly StreamDescriptor[];     // [#11]
  monitor: readonly MonitorSourceSpec[];    // [#11] stream-vs-poll per data kind
  supportedOps: readonly OperationKind[];   // operation-centric declaration
  settings: SettingsSpec;                   // [#5] typed knobs (pure data)
  funding: { canDeposit: boolean; canWithdraw: boolean; transfersAcrossWallets: boolean };
}

// -----------------------------------------------------------------------------
// NORMALIZED DOMAIN — thin lingua franca. [#7] subaccount OPTIONAL everywhere.
// [#13] NO core-computed fields (liquidationDistancePct / estPoolSharePct gone;
// adapter-REPORTED values only, via raw). Every type carries the single
// sanctioned `.raw` leak valve (core/ui lint-banned from reading it).
// -----------------------------------------------------------------------------
export interface Market {
  id: MarketId; chainId: ChainId; product: ProductKind; base: string; quote: string;
  tickSize: Decimal; stepSize: Decimal; minNotional: Decimal;
  makerFeeBps: Bps; takerFeeBps: Bps; maxLeverage?: number; raw: unknown;
}
export interface Subaccount { id: string; owner: Address; label?: string; raw: unknown; }

// [#4] AccountHandle keyed by (protocolId?, chainId). protocolId OPTIONAL:
// undefined === a pure chain-level handle (no protocol adapter — A1). readiness
// OPTIONAL: a chain-level handle has no readiness lifecycle. One wallet (one
// `owner` Address) composes MANY handles, one per (protocol, chain[, sub]).
export interface AccountHandle {
  protocolId?: string;          // undefined => chain-level (contract-call / sign->send)
  chainId: ChainId;
  owner: Address;
  walletId?: WalletId;
  subaccount?: Subaccount;      // [#7] optional
  readiness?: ReadinessState;   // [#8] one of manifest.account.readinessStates (absent when chain-level)
  raw: unknown;
}
export const CHAIN_LEVEL = 'chain' as const; // named, not a magic literal (kind-1 minor fix)
export type AccountKey = string; // `${protocolId ?? CHAIN_LEVEL}:${chainId}:${subaccountId ?? 'default'}`
export function accountKey(h: AccountHandle): AccountKey {
  return `${h.protocolId ?? CHAIN_LEVEL}:${String(h.chainId)}:${h.subaccount?.id ?? 'default'}`;
}
// One wallet composes many handles across protocols and chains (A4/F23).
export interface WalletComposite {
  walletId: WalletId;
  owners: Partial<Record<ChainFamily, Address>>;
  handles: AccountHandle[];
}

export interface Order {
  clientId: string; venueId?: string; market: MarketId; subaccount?: Subaccount; // [#7]
  side: 'buy' | 'sell'; kind: OrderKind; role: OrderRole;
  price?: Decimal; size: Decimal; filled: Decimal; remaining: Decimal;
  tif?: Tif; postOnly: boolean; reduceOnly: boolean;
  status: 'pending' | 'open' | 'partial' | 'filled' | 'cancelled' | 'rejected' | 'expired';
  avgFillPrice?: Decimal; createdMs: number; updatedMs: number; reason?: string; raw: unknown;
}
export interface Position {
  market: MarketId; subaccount?: Subaccount; side: 'long' | 'short' | 'flat'; // [#7]
  size: Decimal; entryPrice: Decimal; markPrice: Decimal; unrealizedPnl: Decimal;
  leverage: number; marginMode: MarginMode;
  liquidationPrice?: Decimal;   // adapter/protocol-REPORTED only
  // [#13] liquidationDistancePct REMOVED — compute-in-core forbidden; DISPLAY/warn
  // consumers derive it transiently from reported values, never store it here.
  raw: unknown;
}
export interface Balance {
  asset: string; symbol: string; total: Decimal; available: Decimal;
  usdValue?: Usd; scope?: 'spot' | 'perp' | 'margin' | 'native'; subaccount?: Subaccount; raw: unknown; // [#7]
}
export interface Fill {
  id: string; orderClientId?: string; market: MarketId; subaccount?: Subaccount; // [#7]
  side: 'buy' | 'sell'; role: OrderRole;
  price: Decimal; size: Decimal; fee: Decimal; feeAsset: string; ts: number; raw: unknown;
}
export interface OrderBookLevel { price: Decimal; size: Decimal; }
export interface OrderBook { market: MarketId; bids: OrderBookLevel[]; asks: OrderBookLevel[]; ts: number; raw: unknown; }

// [#13/#3-fix] Typed lending domain (closes the kind-3 "no typed lending domain,
// .raw would trip the lint-ban in core/ui" leak). healthFactor/APY are
// ADAPTER-REPORTED only — never core-computed.
export interface LendingReserve {
  reserve: string; asset: string; symbol: string;
  supplyApy?: Bps; variableBorrowApy?: Bps; ltv?: Bps; liquidationThreshold?: Bps; raw: unknown;
}
export interface LendingPosition {
  reserve: string; subaccount?: Subaccount;
  suppliedAmount: Amount; borrowedAmount: Amount;
  healthFactor?: Decimal; collateralUsd?: Usd; debtUsd?: Usd; raw: unknown; // reported only (F25/Q8)
}

export interface RewardsSnapshot {
  epoch: string; points?: Decimal; tier?: string; rank?: number; volumeUsd?: Usd;
  // [#13] estPoolSharePct REMOVED — adapter-reported only, via raw.
  raw: unknown;
}

// [#11/#3-fix] NormalizedEvent is EXTENDED with 'lending' and 'market_data'
// variants so polled lending health and polled pool reserves/spot-price can
// reach the per-wallet store the UI binds to (closes the kind-3 & kind-4
// "closed NormalizedEvent / poll declaration verifies but delivery leaks" leaks).
export type NormalizedEvent =
  | { t: 'fill'; key: AccountKey; fill: Fill }
  | { t: 'order'; key: AccountKey; order: Order }
  | { t: 'position'; key: AccountKey; position: Position }
  | { t: 'balance'; key: AccountKey; balances: Balance[] }
  | { t: 'tx_status'; key: AccountKey; hash: Hex | string; status: 'pending' | 'success' | 'reverted' }
  | { t: 'lending'; key: AccountKey; position: LendingPosition }
  | { t: 'market_data'; key: string; dataKind: DataKind;
      value: { spotPrice?: Decimal; reserve0?: Decimal; reserve1?: Decimal; [k: string]: Decimal | undefined };
      ts: number; raw: unknown };

// -----------------------------------------------------------------------------
// [#9] NORMALIZED ADAPTER ERROR — core retry branches ONLY on category/retrySafe.
// (F22/Q16) Adapters/chain module map venue/wative/RPC codes into this shape.
// -----------------------------------------------------------------------------
export type ErrorCategory =
  | 'retryable-safe'    // provably not landed (rejected pre-broadcast / failed build) => resend OK
  | 'retryable-unsafe'  // may have landed (RPC_UNREACHABLE / timeout) => reconcile-by-hash FIRST
  | 'rejected'          // venue/chain rejected; do not resend
  | 'rate-limited'      // back off per the bucket
  | 'auth'              // signer / permission failure
  | 'network';          // connectivity / registry miss
export interface AdapterError {
  category: ErrorCategory;
  retrySafe: boolean;   // mirror of (category === 'retryable-safe')
  message: string;
  code?: string;        // original venue/RPC code, e.g. '2028', 'RPC_UNREACHABLE'
  retryAfterMs?: number;
  raw: unknown;
}

// -----------------------------------------------------------------------------
// SIGNING RUNTIME — chain-neutral. Keys never leave the browser; the adapter
// never sees key material. (kept from v1)
// -----------------------------------------------------------------------------
export interface Eip712TypedData { domain: unknown; types: unknown; primaryType: string; message: unknown; }
export interface WalletSigner {
  readonly address: Address;
  signTypedData?(td: Eip712TypedData, chainId: number): Promise<Hex>; // strict EIP-712 (EVM)
  signDigest?(digest: Hex): Promise<Hex>;                              // EIP-712 escape hatch
  signMessage(msg: string | Uint8Array): Promise<Hex | Uint8Array>;
  signBytes(bytes: Uint8Array): Promise<Uint8Array>;                   // ed25519 / raw path
  toViemAccount?(): import('viem').LocalAccount;                       // EVM-only bridge, optional
}

// -----------------------------------------------------------------------------
// [#10] NONCES — SPLIT. ONE core-owned per-(wallet,chain) ON-CHAIN lane, shared
// across ALL on-chain producers (custody funding, contract-call, sign->send).
// Protocol ORDER nonces stay SEPARATE (adapter-specific). (F24/Q16)
// -----------------------------------------------------------------------------
export interface NonceLease { nonce: number; commit(): void; release(): void }
export interface OnChainNonceSource {
  lease(walletId: WalletId, chainId: ChainId): Promise<NonceLease>; // leased, monotonic, per (wallet, chain)
  peek(walletId: WalletId, chainId: ChainId): Promise<number>;
  reconcile(walletId: WalletId, chainId: ChainId, onChainNext: number): void; // drift repair
}
export interface ProtocolNonceSource {
  timestamp(): bigint;                                   // timestamp order_nonce (uint64)
  nextProtocolSeq(walletId: WalletId, scope?: string): Promise<number>; // protocol sequential seq, if any
}

// -----------------------------------------------------------------------------
// [#14] SECURITY DISPLAY + LABELS — non-blocking (A2 PERMISSIVE). Core-side
// decode+display of what is ACTUALLY signed (WYSIWYS) for chain ops; adapter-
// supplied preview for protocol executes (honest trust-asymmetry, A5/Q14).
// Typed safety labels drive WARNINGS only. Adapters trusted (no sandbox).
// Optional config caps enforced by the scheduler/plan when enabled. (A2/Q13/Q14)
// -----------------------------------------------------------------------------
export type BlastRadiusClass = 'none' | 'trading' | 'approval' | 'funds-move' | 'account-control';
export interface SafetyLabel {
  destructive: boolean;          // cancels/overwrites state
  grantsStandingAuth: boolean;   // e.g. ERC20 approve / setApprovalForAll / link_signer
  movesFunds: boolean;           // deposit/withdraw/transfer/value>0
  requiresPrimaryKey: boolean;   // not satisfiable by the hot linked-signer
  blastRadiusClass: BlastRadiusClass;
  dangerousSelectors?: readonly string[]; // flagged selectors — WARN, never block (A2)
}
export interface DecodedArg { name?: string; type: string; value: string; }
export type WarningSeverity = 'info' | 'warn' | 'danger';
export interface SecurityWarning { severity: WarningSeverity; code: string; message: string }
// What is ACTUALLY being signed, decoded + labelled + warned. NON-BLOCKING.
export interface SignedPayloadPreview {
  summary: string;               // human one-liner shown in the confirm drawer
  signedKind: 'eip712' | 'digest' | 'raw-tx' | 'message';
  chainId?: ChainId;
  to?: Address;
  method?: string;
  decodedArgs?: readonly DecodedArg[]; // core-decoded for chain ops; adapter-supplied for protocol
  value?: Amount;                // native value moved
  label: SafetyLabel;
  warnings: readonly SecurityWarning[];
  decodedByCore: boolean;        // true for chainCall/rawTx (independent); false => adapter-asserted
  raw: unknown;
}
// Optional config caps — enforced by core/scheduler + core/plan ONLY when enabled.
export interface SpendCapPolicy {
  enabled: boolean;
  perOpUsd?: Usd; perWalletWindowUsd?: Usd; perCohortUsd?: Usd; globalPerWindowUsd?: Usd;
  windowMs?: number;
  maxBlastRadius?: BlastRadiusClass; // refuse/pause ops above this class when set
  allowanceCapNative?: Amount;       // bound non-MAX allowances when enabled
}
export type ConfirmFn = (preview: SignedPayloadPreview) => Promise<boolean>; // per-op confirm (permissive)

// Stateful spend-cap enforcement across ops. Implemented by core (SpendCapEnforcer)
// and held by the composition root; the plan runner consults it per step when present.
export interface SpendRequest { walletId: WalletId; cohortId?: string; usd: number; blastRadius: BlastRadiusClass }
export interface SpendDecision { allowed: boolean; code?: string; reason?: string }
export interface SpendEnforcer { charge(req: SpendRequest): SpendDecision }

// -----------------------------------------------------------------------------
// EXECUTION PLAN — correctness kernel (kept). Steps carry optional WYSIWYS
// `preview` + `safety` so the confirm drawer shows what is signed. [#14]
// -----------------------------------------------------------------------------
export interface UnsignedTx { to?: Hex; data: Hex; value?: bigint; chainId: number; gasLimit?: bigint; }
export type PlanStep =
  | { type: 'onchain-tx'; tx: UnsignedTx; bucket: string; weight: number;
      preview?: SignedPayloadPreview; safety?: SafetyLabel; notionalUsd?: number }
  | { type: 'protocol-execute'; typedData?: Eip712TypedData; chainId?: number;
      fallbackDigest?: Hex; bucket: string; weight: number;
      preview?: SignedPayloadPreview; safety?: SafetyLabel; notionalUsd?: number;
      submit: (sig: Hex | Uint8Array) => Promise<unknown> };
export interface ExecutionPlan { steps: PlanStep[]; describe: string; preview?: SignedPayloadPreview; }
export interface PlanResult { ok: boolean; stepResults: unknown[]; txHashes: (Hex | string)[]; raw: unknown }
// [#audit] Aligned to wative-core's exported SimulationResult shape so core/plan
// maps it near-passthrough, plus a core-added non-blocking `warnings` overlay for
// the confirm drawer. (wative: success/error/logs/returnData/gasUsed/raw.)
export interface SimulationResult {
  success: boolean;
  error?: string;
  logs?: readonly string[];
  returnData?: string;
  gasUsed?: bigint;
  warnings: SecurityWarning[]; // core overlay (non-blocking)
  raw: unknown;
}
export interface PlanRunner {
  run(plan: ExecutionPlan, ctx: SignerContext): Promise<PlanResult>;
  simulate?(plan: ExecutionPlan, ctx: SignerContext): Promise<SimulationResult>;
}

// -----------------------------------------------------------------------------
// SIGNER CONTEXT — threads the shared lanes + permissive controls.
// -----------------------------------------------------------------------------
export interface SignerContext {
  signer: WalletSigner;
  account: AccountHandle;        // carries chainId + protocolId? (A4)
  chain: ChainSpec;              // resolved from the chain registry
  walletId: WalletId;
  onchainNonces: OnChainNonceSource;   // [#10] shared on-chain lane
  protocolNonces: ProtocolNonceSource; // [#10] separate protocol order-nonce
  runner: PlanRunner;            // core-owned plan runner (kernel)
  confirm?: ConfirmFn;           // permissive per-op confirm (A2)
  caps?: SpendCapPolicy;         // optional caps (A2/[#14])
  enforcer?: SpendEnforcer;      // optional stateful cap enforcement (per-op/wallet/cohort/global)
}

// -----------------------------------------------------------------------------
// INPUTS — subaccount OPTIONAL (F11). Direction/appetite is a plain parameter;
// there is NO strategy upstream (D7/D8). [#7]
// -----------------------------------------------------------------------------
export interface PlaceOrderInput {
  market: MarketId; subaccount?: Subaccount;              // [#7]
  side: 'buy' | 'sell'; kind: OrderKind; size: Decimal; price?: Decimal; // price omitted => market/taker
  tif?: Tif; postOnly?: boolean; reduceOnly?: boolean; expiryMs?: number;
  selfTradePrevention?: StpMode;                          // [#12] pass-through only
  trigger?: { kind: TriggerKind; triggerPrice: Decimal }; // [#12] pass-through only
  clientId: string;
  // hints: protocol pass-through. nonce/expiration are optional idempotency hints for a
  // deterministic protocol-execute retry — supplying a stable (jobId-derived) order nonce +
  // expiration makes a retry rebuild the BYTE-IDENTICAL signed order, so a resend of a write
  // that may have landed is deduped by the venue instead of double-placing.
  hints?: { spotLeverage?: boolean; nonce?: string; expiration?: string };
}
export interface CancelInput { market?: MarketId; subaccount?: Subaccount; clientIds?: string[]; venueIds?: string[]; } // [#7]
export interface ReplaceInput { cancel: CancelInput; place: PlaceOrderInput; }
export interface DepositRequest  { asset: string; amount: Amount; subaccount?: Subaccount; }
export interface WithdrawRequest { asset: string; amount: Amount; subaccount?: Subaccount; } // [#7] (was required)
export interface NormalizedOrder { input: PlaceOrderInput; role: OrderRole }

// Lending inputs (new KIND, A3 bounded-additive).
export interface SupplyInput  { reserve: string; asset: string; amount: Amount; subaccount?: Subaccount }
export interface BorrowInput  { reserve: string; asset: string; amount: Amount; rateMode?: 'variable' | 'stable'; subaccount?: Subaccount }
export interface RepayInput   { reserve: string; asset: string; amount: Amount; subaccount?: Subaccount }
export interface WithdrawSupplyInput { reserve: string; asset: string; amount: Amount; subaccount?: Subaccount }

// [#2] CHAIN-LEVEL PRIMITIVES — contract-call + sign->send as FIRST-CLASS inputs,
// usable with NO protocol adapter. (A1/F8/Q5)
export interface ChainCallInput {
  chainId: ChainId; to: Address; abi: unknown; method: string; args: readonly unknown[];
  value?: Amount; gasLimit?: bigint; clientId: string;
}
export interface RawTxInput {
  chainId: ChainId; to?: Address; data: Hex; value?: Amount; gasLimit?: bigint;
  raw?: unknown; clientId: string; // foreign / dApp-supplied tx passthrough
}

// -----------------------------------------------------------------------------
// [#6] UNIFIED OPERATION UNION — the SERIALIZABLE atom the automation engine fans
// out. Protocol ops carry a protocolId (routed to port.execute, which the adapter
// dispatches internally). Chain ops carry none (routed to core/chain). (Q6/F10)
// NO function-bearing fields: ensureSubaccount / provisionDelegatedSigner / deposit
// are ExecutionPlan BUILDERS on the port, NOT Operation variants (keeps templates
// importable/exportable and lets a 2-tx deposit be one plan).
// -----------------------------------------------------------------------------
export type OperationKind =
  | 'placeOrder' | 'cancel' | 'replace'
  | 'supply' | 'borrow' | 'repay' | 'withdrawSupply'
  | 'chainCall' | 'rawTx';

export type Operation =
  | { kind: 'placeOrder'; protocolId: string; chainId: ChainId; input: PlaceOrderInput }
  | { kind: 'cancel';     protocolId: string; chainId: ChainId; input: CancelInput }
  | { kind: 'replace';    protocolId: string; chainId: ChainId; input: ReplaceInput }
  | { kind: 'supply';         protocolId: string; chainId: ChainId; input: SupplyInput }
  | { kind: 'borrow';         protocolId: string; chainId: ChainId; input: BorrowInput }
  | { kind: 'repay';          protocolId: string; chainId: ChainId; input: RepayInput }
  | { kind: 'withdrawSupply'; protocolId: string; chainId: ChainId; input: WithdrawSupplyInput }
  | { kind: 'chainCall';  protocolId?: undefined; chainId: ChainId; input: ChainCallInput } // A1 — no adapter
  | { kind: 'rawTx';      protocolId?: undefined; chainId: ChainId; input: RawTxInput };     // A1 — no adapter

export type PlaceOrderOp     = Extract<Operation, { kind: 'placeOrder' }>;
export type CancelOp         = Extract<Operation, { kind: 'cancel' }>;
export type ReplaceOp        = Extract<Operation, { kind: 'replace' }>;
export type ChainCallOp      = Extract<Operation, { kind: 'chainCall' }>;
export type RawTxOp          = Extract<Operation, { kind: 'rawTx' }>;
export type ProtocolOperation = Extract<Operation, { protocolId: string }>;
export type ChainOperation    = ChainCallOp | RawTxOp;

export interface TxReceiptView { chainId: ChainId; hash: Hex | string; status: 'success' | 'reverted' | 'pending'; blockNumber?: number; raw: unknown }

// Typed result per op kind -> OpResultOf infers the return type of execute<O>.
export interface OpResultMap {
  placeOrder: Order;
  cancel: { cancelled: string[] };
  replace: Order;
  supply: TxReceiptView;
  borrow: TxReceiptView;
  repay: TxReceiptView;
  withdrawSupply: TxReceiptView;
  chainCall: TxReceiptView;
  rawTx: TxReceiptView;
}
export type OpResultOf<O extends { kind: keyof OpResultMap }> = OpResultMap[O['kind']];

// -----------------------------------------------------------------------------
// [#6] ACTION TEMPLATE — ordered steps over the Operation union; per-step jitter
// ranges; inter-step semantics; schedule/frequency; target selection; versioning
// + import/export. (Q6/F10)
// -----------------------------------------------------------------------------
export type FailMode = 'stop' | 'continue';
export interface ActionStepTemplate {
  id: string;
  op: OperationKind;                     // template op kind
  protocolId?: string;                   // omitted for chainCall / rawTx
  params: Record<string, ParamBinding>;  // form values; NumberRange => per-wallet jitter
  onFailure: FailMode;                   // [#6] inter-step semantics
  delayAfterMs?: ParamBinding;
}
export type ScheduleSpec =
  | { mode: 'manual' }
  | { mode: 'once'; atMs: number }
  | { mode: 'interval'; everyMs: number; jitterMs?: NumberRange }   // frequency + jitter
  | { mode: 'cron'; expr: string };
export interface TargetSelection {
  kind: 'all' | 'cohort' | 'filter' | 'explicit';
  cohortId?: string;
  tags?: string[];
  filter?: unknown;                      // serializable predicate descriptor (resolved by core)
  walletIds?: WalletId[];
}
export interface ActionTemplate {
  id: string; name: string; version: number; createdMs: number; updatedMs: number;
  steps: ActionStepTemplate[];           // ordered
  schedule: ScheduleSpec;
  target: TargetSelection;
  stopOnFleetError?: boolean;            // inter-wallet semantics (vs per-step onFailure)
  caps?: SpendCapPolicy;                 // [#14] optional per-template caps
}
export interface SerializedActionTemplate { schema: 'farm.action-template/v2'; template: ActionTemplate }
// core/automation turns a template step + a wallet into a concrete Operation
// (sampling each NumberRange per wallet). Bridge from template -> execute(op).
export type StepExpander = (step: ActionStepTemplate, ctx: SignerContext) => Operation;

// -----------------------------------------------------------------------------
// RATE ACCOUNTING — AdapterOp gains chain-level variants. [#2]
// -----------------------------------------------------------------------------
export type AdapterOp =
  | { kind: 'placeOrder'; postOnly: boolean; spotLeverage?: boolean }
  | { kind: 'cancelOrders' } | { kind: 'replaceOrders' }
  | { kind: 'supply' } | { kind: 'borrow' } | { kind: 'repay' } | { kind: 'withdrawSupply' }
  | { kind: 'deposit' } | { kind: 'withdraw' } | { kind: 'linkSigner' }
  | { kind: 'chainCall'; chainId: ChainId } // [#2]
  | { kind: 'rawTx'; chainId: ChainId }      // [#2]
  | { kind: 'readCall'; chainId: ChainId }   // [#2-fix] eth_call view read (quotes/reserves)
  | { kind: 'query'; endpoint: string };
export interface RateCost { bucket: string; scope: RateScope; weight: number; }

// -----------------------------------------------------------------------------
// ADAPTER ENV — kept; now also hands adapters the chain registry. [#3]
// -----------------------------------------------------------------------------
export interface AdapterEnv {
  request<T>(a: { bucket: string; scope: RateScope; weight: number; key?: string;
    method: 'GET' | 'POST'; url: string; body?: unknown; signal?: AbortSignal }): Promise<T>;
  openSocket(s: { url: string; bucket: string }): WebSocket;
  chains: ChainRegistry;        // [#3] registry access for adapters
  kv: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> };
  clock: { now(): number };
  logger: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
}

// -----------------------------------------------------------------------------
// STREAMING — targets are AccountHandles (subaccount optional). [#7][#11]
// -----------------------------------------------------------------------------
export interface StreamSink { onEvent(e: NormalizedEvent): void; onError(e: AdapterError): void; onReconnect(): void; }
export interface Subscription { addTargets(t: AccountHandle[]): void; removeTargets(t: AccountHandle[]): void; close(): void; }

// =============================================================================
// [#1] THE UNIVERSAL CORE PORT — the SMALL surface EVERY adapter satisfies.
// Nothing trading-specific lives here. A lending adapter implements only this +
// `execute` for its lending ops + exposes capability('lending'); it never
// stub-throws order methods because those live on TradingCapability.
// =============================================================================
export interface ProtocolPort {
  readonly manifest: ProtocolManifest;
  init(env: AdapterEnv): Promise<void>;
  dispose(): Promise<void>;

  // universal
  costOf(op: AdapterOp): RateCost[];
  resolveAccount(a: { owner: Address; chainId: ChainId; walletId?: WalletId; subaccountName?: string }): Promise<AccountHandle>; // [#4]
  getBalances(a: AccountHandle): Promise<Balance[]>;
  subscribe(targets: AccountHandle[], kinds: DataKind[], sink: StreamSink): Subscription; // [#7][#11]

  // operation-centric spine: ONE declared path for every protocol op the adapter
  // supports. The adapter dispatches on op.kind INTERNALLY — so a new KIND never
  // forces a core per-kind router edit. (candidate-2 graft)
  supports(op: OperationKind): boolean;
  preview(ctx: SignerContext, op: ProtocolOperation): Promise<SignedPayloadPreview>; // [#14] adapter-asserted WYSIWYS
  execute<O extends ProtocolOperation>(ctx: SignerContext, op: O): Promise<OpResultOf<O>>;

  // funding — "as applicable" (ExecutionPlan BUILDERS, not Operation variants;
  // lets approve+deposit be ONE plan / multiple on-chain txs).
  prepareDeposit?(ctx: SignerContext, r: DepositRequest): Promise<ExecutionPlan>;
  prepareWithdraw?(ctx: SignerContext, r: WithdrawRequest): Promise<ExecutionPlan>;

  // account/subaccount lifecycle — optional (no degenerate ref for flat venues)
  listSubaccounts?(owner: Address, chainId: ChainId): Promise<Subaccount[]>;
  ensureSubaccount?(ctx: SignerContext, name?: string): Promise<ExecutionPlan>;
  provisionDelegatedSigner?(ctx: SignerContext, hot: WalletSigner): Promise<ExecutionPlan>;

  // rewards DISPLAY — optional
  getRewards?(a: AccountHandle): Promise<RewardsSnapshot>;

  // [#9] normalized error mapping — core branches retry on the result
  normalizeError(e: unknown): AdapterError;

  // [#14] typed safety labels for WARNINGS (non-blocking); adapter is trusted
  labelOperation(op: Operation): SafetyLabel;

  // [#1] typed capability accessor — returns the opt-in sub-interface or undefined
  capability<K extends CapabilityId>(id: K): CapabilityMap[K] | undefined;
}

// =============================================================================
// [#1] OPT-IN CAPABILITY SUB-INTERFACES — an adapter implements only those its
// protocol kind supports. Write methods are thin wrappers that build an
// Operation and call port.execute; read methods are the typed surface the UI uses.
// =============================================================================
export interface TradingCapability {
  getMarkets(): Promise<Market[]>;
  getOrderBook(m: MarketId, depth?: number): Promise<OrderBook>;
  getPositions(a: AccountHandle): Promise<Position[]>;
  getOpenOrders(a: AccountHandle): Promise<Order[]>;
  getFills(a: AccountHandle, since?: number): Promise<Fill[]>;
  // input hygiene only (tick/step rounding + final maker/taker role). [#12] no
  // longer feeds a no-self-cross guard.
  normalizeOrder(i: PlaceOrderInput, m: Market): NormalizedOrder;
  // thin wrappers over port.execute():
  placeOrder(ctx: SignerContext, i: PlaceOrderInput): Promise<Order>;
  cancelOrders(ctx: SignerContext, c: CancelInput): Promise<{ cancelled: string[] }>;
  replaceOrder?(ctx: SignerContext, r: ReplaceInput): Promise<Order>;
}
export interface LendingCapability {
  getReserves(): Promise<LendingReserve[]>;
  getLendingPositions(a: AccountHandle): Promise<LendingPosition[]>;
  supply(ctx: SignerContext, i: SupplyInput): Promise<TxReceiptView>;
  borrow(ctx: SignerContext, i: BorrowInput): Promise<TxReceiptView>;
  repay(ctx: SignerContext, i: RepayInput): Promise<TxReceiptView>;
  withdrawSupply(ctx: SignerContext, i: WithdrawSupplyInput): Promise<TxReceiptView>;
}
// Reserved — swap rides chainCall until a 2nd AMM justifies a first-class swap
// op (A3 promotion). Shape kept minimal; getQuote uses the chain read primitive.
export interface SwapCapability {
  getQuote(i: { chainId: ChainId; tokenIn: string; tokenOut: string; amountIn: Amount; slippageBps?: Bps }): Promise<{ amountOut: Amount; raw: unknown }>;
  swap(ctx: SignerContext, i: { chainId: ChainId; tokenIn: string; tokenOut: string; amountIn: Amount; minOut: Amount }): Promise<TxReceiptView>;
}

// Full adapter = universal port + optional capability sub-objects.
export interface ProtocolAdapter extends ProtocolPort {
  trading?: TradingCapability;
  lending?: LendingCapability;
  swap?: SwapCapability;
}

// =============================================================================
// [#2] CHAIN-LEVEL PRIMITIVES PORT — implemented by core/chain (NOT an adapter),
// keyed by the chain registry. Serves the generic approve+call "protocol" (A1)
// with NO ProtocolPort at all. Routed through the SAME ExecutionPlan runner;
// costs priced per-chain via AdapterOp chainCall/rawTx/readCall.
//
// Closes the kind-1 & kind-4 leaks: balances + ERC20 balances + eth_call view
// read + revoke-approval helper all live here, so a no-adapter chain account is
// fully usable (display + quotes + evacuate) WITHOUT stubbing a ProtocolPort.
// =============================================================================
export interface ChainReadResult { decoded: readonly DecodedArg[]; raw: unknown }
export interface ChainPrimitives {
  readonly chains: ChainRegistry;
  costOf(op: AdapterOp): RateCost[];                                   // chainCall / rawTx / readCall
  resolveChainAccount(a: { owner: Address; chainId: ChainId; walletId?: WalletId }): Promise<AccountHandle>; // protocolId undefined
  getNativeBalance(owner: Address, chainId: ChainId): Promise<Balance>;              // [#2-fix] balance display
  getErc20Balances(owner: Address, chainId: ChainId, tokens: readonly string[]): Promise<Balance[]>; // [#2-fix]
  readCall(i: ChainCallInput): Promise<ChainReadResult>;              // [#2-fix] eth_call VIEW (quotes/reserves), no signer/nonce/plan
  prepareChainCall(ctx: SignerContext, i: ChainCallInput): Promise<ExecutionPlan>;
  prepareRawTx(ctx: SignerContext, i: RawTxInput): Promise<ExecutionPlan>;
  execute<O extends ChainOperation>(ctx: SignerContext, op: O): Promise<OpResultOf<O>>;
  decode(i: ChainCallInput | RawTxInput): Promise<SignedPayloadPreview>; // [#14] core-side WYSIWYS (decodedByCore:true)
  normalizeError(e: unknown): AdapterError;                           // [#9] for chain-level ops
  revokeApprovalOp(chainId: ChainId, token: Address, spender: Address): ChainCallOp; // [#2-fix] A2 evacuate-revoke (approve(spender,0))
}

// =============================================================================
// UI COMPOSERS — generic product surface (no per-protocol branching). [#5]
// renderStrategyForm is GONE (D7/D8). [#12]
// =============================================================================
export interface FormField { schema: ParamSchema; visible: boolean; value?: ParamBinding }
export interface FormModel { fields: FormField[] }
export type RenderSettingsForm = (spec: SettingsSpec, caps: ManifestCapabilities) => FormModel;
export type RenderActionForm   = (op: OperationKind, spec: SettingsSpec, caps: ManifestCapabilities) => FormModel;