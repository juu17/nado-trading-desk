// =============================================================================
// @farm/adapter-nado · manifest — the universal facts + opt-in trading capability
// declaration the console renders generically. Pure data; no per-protocol code in
// core/ui keys off anything but this.
// =============================================================================
import type { ProtocolManifest } from "@farm/adapter-api";

const INK_MAINNET = 57073;
const INK_TESTNET = 763373;

export const NADO_MANIFEST: ProtocolManifest = {
  id: "nado",
  displayName: "Nado",
  version: 1,
  chains: [INK_MAINNET, INK_TESTNET],
  capabilities: {
    implemented: ["trading"],
    trading: {
      products: ["spot", "perp"],
      orderKinds: ["limit", "market"],
      postOnly: true,
      reduceOnly: true,
      batchReplace: true,
      selfTradePrevention: ["none", "cancel-oldest", "cancel-newest", "cancel-both"],
      triggers: ["tp", "sl", "twap"],
      marketMicrostructure: ["clob"],
      perp: { marginModes: ["isolated", "cross"] },
    },
    rewards: false,
  },
  account: {
    subaccounts: true,
    subaccountIdKind: "bytes32",
    delegatedSigner: true,
    withdrawalRequiresPrimary: true,
    createsOnFirstDeposit: true,
    readinessStates: [
      { id: "unfunded", label: "Unfunded" },
      { id: "funded", label: "Funded" },
      { id: "ready", label: "Ready", terminalReady: true },
    ],
  },
  signing: {
    family: "evm",
    scheme: "eip712-strict",
    chainId: INK_MAINNET,
    verifyingContract: "per-market", // order verifyingContract derives from productId
    digestFallback: true,            // Phase 1a: strict accepted all; fallback kept as a belt
  },
  rateLimits: [
    // Nado sequencer per-IP READ/cancel budget, CALIBRATED on the Ink testnet (2026-10-16):
    // the client RateLimiter is the pacing knob (the relay forwards from ONE egress IP, so
    // the whole in-tab cohort shares this per-IP bucket). Measured: ~3/s sustained is clean,
    // ~5/s+ sustained is throttled (429), and a burst up to ~12 concurrent is tolerated when
    // the trailing window is clear. A token bucket of 6 tokens / 3s → 2/s steady REFILL (the
    // knob that bounds the SUSTAINED rate when poll bursts overlap) with a burst of 6 keeps
    // the whole cohort clearly under the ~3/s throttle while a single poll's reads still fire
    // without pacing; the relay's 429 retry-with-backoff absorbs residual overage. (The old
    // 600/60s sliding-window gave NO real pacing — it let 600 reads through instantly.)
    { bucket: "nado:rest", scope: "ip", algo: "token-bucket", capacity: 6, windowMs: 3_000, verifiedOnTestnet: true },
    // Orders are per-subaccount (independent buckets), so they add little per-IP pressure;
    // 2/s steady per subaccount with a small burst (not the read bottleneck on testnet).
    { bucket: "nado:place", scope: "subaccount", algo: "token-bucket", capacity: 10, windowMs: 5_000, verifiedOnTestnet: false },
  ],
  streams: [
    { kind: "order_update", auth: "per-wallet", multiplex: "one-subject-per-conn", maxAuthConnsPerWallet: 5, scarce: true },
    // `fills` + `position_change` are PUBLIC — subscribed KEYLESS by subaccount hex (no WS
    // authenticate). `fills` is live-verified (Stage 2a); `position_change` is public per the
    // vendor streams table + the order_update RE (only order_update is auth-gated) and is
    // subscribed keyless since scaling W3. Many subjects multiplex over the ONE public socket, so
    // they scale off the per-IP relay budget — the console subscribes both cohort-wide and routes
    // each (by `subaccount`) to a targeted reconcile. The per-socket SUBJECT cap is not yet
    // measured; it is not expressible here (no maxSubjectsPerConn field) and socket-pool sharding
    // is the deferred scale follow-up.
    { kind: "fills", auth: "none", multiplex: "many-subjects-per-conn" },
    { kind: "position_change", auth: "none", multiplex: "many-subjects-per-conn" },
    { kind: "book", auth: "none", multiplex: "many-subjects-per-conn" },
  ],
  monitor: [
    { dataKind: "fills", source: "stream" },
    { dataKind: "order_update", source: "stream" },
    { dataKind: "position_change", source: "stream-with-poll-reconcile", pollIntervalMs: 5_000 },
    { dataKind: "book", source: "stream" },
    { dataKind: "balance", source: "poll", pollIntervalMs: 5_000 },
  ],
  supportedOps: ["placeOrder", "cancel", "replace", "chainCall", "rawTx"],
  // Typed param schema — the generic action form (renderActionForm) is built from
  // this DATA, with zero per-protocol UI branching. Market options are a static
  // sample here; a live console injects them from the gateway's market list.
  settings: [
    { id: "market", label: "Market", kind: "enum", required: true, default: "nado:perp:BTC-PERP", options: [
      { value: "nado:perp:BTC-PERP", label: "BTC-PERP" },
      { value: "nado:perp:ETH-PERP", label: "ETH-PERP" },
      { value: "nado:spot:INK-USDT0", label: "INK-USDT0" },
    ] },
    { id: "side", label: "Side", kind: "enum", default: "buy", capabilityGate: "trading", options: [
      { value: "buy", label: "Buy" }, { value: "sell", label: "Sell" },
    ] },
    { id: "kind", label: "Type", kind: "enum", default: "limit", capabilityGate: "trading", options: [
      { value: "limit", label: "Limit" }, { value: "market", label: "Market" },
    ] },
    { id: "size", label: "Size", kind: "decimal", required: true, default: "0.1", help: "base units; toggle jitter for a per-wallet range" },
    { id: "price", label: "Price", kind: "decimal", default: "63120", help: "limit price; ignored for market orders" },
  ],
  funding: { canDeposit: true, canWithdraw: true, transfersAcrossWallets: false },
};
