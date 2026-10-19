// =============================================================================
// @farm/adapter-stub-lend · manifest — a DELIBERATELY-DIFFERENT second adapter (the
// Phase-2.5 over-abstraction detector, AUDIT F21/Q1). Where Nado is a CLOB PERP
// venue (trading capability, off-chain order EIP-712, bytes32 subaccounts), this is
// a STUB LENDING venue: the `lending` capability, supply/borrow/repay/withdrawSupply
// ops, a DIFFERENT EIP-712 domain (ERC-2612 permit), NO subaccounts, a 2-state
// readiness. It is pure manifest DATA — the console renders it with zero per-protocol
// branching, and building it requires ZERO edits to @farm/core, @farm/ui, or the seam.
// =============================================================================
import type { ProtocolManifest } from "@farm/adapter-api";

// A generic EVM testnet, deliberately NOT Ink (Nado's chain) — this is a different venue.
const STUB_CHAIN = 11155111; // Sepolia

export const STUB_LEND_MANIFEST: ProtocolManifest = {
  id: "stub-lend",
  displayName: "Stub Lend",
  version: 1,
  chains: [STUB_CHAIN],
  capabilities: {
    implemented: ["lending"], // NOT "trading" — proves capability('trading') === undefined isn't theater
    lending: { markets: ["USDC", "WETH"], canBorrow: true, canRepay: true },
    rewards: false,
  },
  account: {
    subaccounts: false,       // the strongest genericity signal vs Nado's bytes32 subaccounts
    delegatedSigner: false,
    // A SUBSET of the suggested baseline triplet — @farm/ui narrows Readiness to
    // 'unfunded'|'funded'|'ready', so a stub that wants to RENDER must stay within it.
    // (That narrowing is the one place the seam isn't fully protocol-agnostic — surfaced,
    //  not papered over: a venue needing genuinely different readiness states would force
    //  a small @farm/ui edit.)
    readinessStates: [
      { id: "unfunded", label: "Unfunded" },
      { id: "ready", label: "Ready", terminalReady: true },
    ],
  },
  // A DIFFERENT signing shape than Nado's per-market order domain: a fixed-contract
  // ERC-2612 permit (the off-chain gasless-approve leg a lender signs). Proves the
  // SigningSpec union isn't fitted to Nado.
  signing: { family: "evm", scheme: "eip712-strict", chainId: STUB_CHAIN, verifyingContract: "fixed", digestFallback: false },
  rateLimits: [
    { bucket: "stublend:rpc", scope: "ip", algo: "token-bucket", capacity: 10, windowMs: 1_000 },
  ],
  streams: [
    { kind: "lending_position", auth: "none", multiplex: "many-subjects-per-conn" },
  ],
  monitor: [
    { dataKind: "lending_position", source: "poll", pollIntervalMs: 15_000 },
    { dataKind: "balance", source: "poll", pollIntervalMs: 15_000 },
  ],
  supportedOps: ["supply", "borrow", "repay", "withdrawSupply"], // disjoint from Nado's order ops
  settings: [
    { id: "reserve", label: "Reserve", kind: "enum", required: true, default: "USDC", options: [
      { value: "USDC", label: "USDC" },
      { value: "WETH", label: "WETH" },
    ] },
    { id: "amount", label: "Amount", kind: "decimal", required: true, default: "100", help: "token units" },
    // capabilityGate: "lending" exercises the renderer's gate-filter branch for THIS adapter
    // (and a trading-gated field would be dropped — the opposite of Nado).
    { id: "rateMode", label: "Rate mode", kind: "enum", default: "variable", capabilityGate: "lending", options: [
      { value: "variable", label: "Variable" },
      { value: "stable", label: "Stable" },
    ] },
  ],
  funding: { canDeposit: true, canWithdraw: true, transfersAcrossWallets: false },
};
