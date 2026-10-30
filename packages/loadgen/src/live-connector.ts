// =============================================================================
// @farm/loadgen · live-connector — the composition root that assembles the live
// NadoExperimentConnector for an A/B self-cross cohort. This is the OFFLINE-testable
// assembly (pure wiring over injected seams); the real EngineClient / wative signers /
// MeteredTransport / SharedReadBudget / public `fill` stream are constructed by the
// testnet operator runner and handed in here (so key handling + the live network stay in
// the gated runner, and the wiring logic is unit-tested with fakes).
//
// Composition pre-audit fixes folded in (each green offline / would be red live):
//   #1 OWNER CASING — the coordinator keys/validates wallets by the LOWERCASED owner()
//      (funding/types owner() → value.toLowerCase()); a wative signer address is checksummed.
//      We canonicalise every owner to lowercase and thread that one form through signerFor,
//      forOwner and the cohort owners, so preflight's `owner(fact.a.owner) === pair.a` holds.
//   #2 CLOCK — the connector mints a nonce with BigInt(clock()+90_000); a ClockSync offset of
//      rtt/2 makes now() fractional after a live sync → BigInt(123.5) throws. We floor the
//      clock here so a fractional source can never reach the hot path.
//   #3 WRITE BUCKETS — reads draw the shared "28" budget, but order submits (nado:place) /
//      cancels (nado:rest) are a DIFFERENT bucket; unregistered = unlimited pass-through, so
//      writes would go unmetered. registerNadoWriteBuckets registers them on the one shared
//      limiter (rates are gate-calibrated — see the note there).
//   #4 CHAINID — single-sourced here; the connector also asserts c.chainId === deps.chainId in
//      prepare() so a divergence fails loud + unsent instead of signing the wrong chain.
// =============================================================================
import {
  type RateLimiter,
  type OrderAdmission, type OperationsStore, type ExperimentCampaign,
} from "@farm/core";
import type { MultiWalletNadoGateway, NadoMarketSizing } from "@farm/adapter-nado";
import type { WalletSigner } from "@farm/adapter-api";
import { NadoExperimentConnector, type OrderFillSource, type DispatchErrorNormaliser } from "./experiment-connector.js";

/** The canonical owner form used everywhere in the harness (the coordinator's lowercased
 *  owner()). Always route a signer/pair/gateway owner through this. */
export const canonicalOwner = (addr: string): string => addr.toLowerCase();

export interface LiveConnectorDeps {
  chainId: number;
  /** Nado Endpoint address (the cancel domain's verifyingContract). */
  endpoint: string;
  /** Per-owner gateway views over ONE shared transport + limiter (createMultiWalletNadoGateway). */
  gateway: MultiWalletNadoGateway;
  /** The cohort's custody signers (A, B, …). Mapped to owners by their own address, lowercased. */
  signers: readonly WalletSigner[];
  sizingFor: (productId: number) => NadoMarketSizing;
  marketIdFor: (productId: number) => string;
  /** A monotonic-ish ms time source (e.g. a ClockSync.now wrapped in an arrow). Floored here. */
  clock: () => number;
  /** The live A-5 OrderFillSource (createLiveOrderFillSource). */
  orderFill: OrderFillSource;
  admit: OrderAdmission<ExperimentCampaign>;
  store: OperationsStore<ExperimentCampaign>;
  normaliseError?: DispatchErrorNormaliser;
  /** Post-only maker headroom (ticks from the opposite touch); see NadoExperimentConnectorDeps. */
  makerHeadroomTicks?: number;
}

export interface LiveConnector {
  connector: NadoExperimentConnector;
  /** The cohort's canonical (lowercase) owners, in signer order (A, B, …). */
  owners: string[];
  /** Canonicalise an address to the owner form used across the harness. */
  canonicalOwner: (addr: string) => string;
}

/**
 * Assemble the live connector. Pure composition — no network, no key material (the signers are
 * already-constructed WalletSigners). Every owner is canonicalised to lowercase (#1); the clock
 * is floored (#2); the chainId is single-sourced into the connector (#4).
 */
export function assembleLiveConnector(deps: LiveConnectorDeps): LiveConnector {
  const signerByOwner = new Map<string, WalletSigner>();
  for (const s of deps.signers) {
    const addr = (s.address as { value?: string }).value;
    if (!addr) throw new Error("EXPERIMENT_SIGNER_NO_ADDRESS");
    signerByOwner.set(canonicalOwner(addr), s);
  }
  const owners = [...signerByOwner.keys()];

  const signerFor = (owner: string): WalletSigner => {
    const s = signerByOwner.get(canonicalOwner(owner));
    if (!s) throw new Error(`EXPERIMENT_SIGNER_UNKNOWN:${canonicalOwner(owner)}`);
    return s;
  };
  // forOwner through the shared multi-wallet gateway, always keyed by the canonical owner so a
  // view's reads use the same casing the coordinator validates against.
  const forOwner = (owner: string) => deps.gateway.forOwner(canonicalOwner(owner));
  // Floor the clock so a fractional ClockSync offset can never reach BigInt() in the nonce mint.
  const clock = () => Math.floor(deps.clock());

  const connector = new NadoExperimentConnector({
    chainId: deps.chainId,
    endpoint: deps.endpoint,
    forOwner,
    signerFor,
    sizingFor: deps.sizingFor,
    clock,
    marketIdFor: deps.marketIdFor,
    orderFill: deps.orderFill,
    admit: deps.admit,
    store: deps.store,
    normaliseError: deps.normaliseError,
    makerHeadroomTicks: deps.makerHeadroomTicks,
  });

  return { connector, owners, canonicalOwner };
}

// -----------------------------------------------------------------------------
// Write-bucket registration (#3). The shared single-IP budget meters READS (nado:read, 28/s);
// order submits/cancels use nado:place / nado:rest, which are UNREGISTERED by default →
// unlimited pass-through. Register them on the ONE shared RateLimiter so writes are metered on
// the same authority. The write path (/execute) has a SEPARATE, tighter per-IP limit than the
// query path: LIVE-calibrated 2026-10-30 (scripts/calibrate-write-budget.mjs) — place+cancel was
// clean at 8 pairs/s and the first 429 hit at ~12/s, so the safe sustained write rate is ~8/s
// (well below the 28/s read budget). Re-calibrate before a multi-pair ramp pushes the ceiling.
// -----------------------------------------------------------------------------
/** LIVE-calibrated safe per-IP write rates (ops/sec) — the highest clean place/cancel rate below
 *  the first 429. A single pair stays far under this; it binds the multi-pair ramp, not N=1. */
export const NADO_PLACE_RATE = 8;
export const NADO_CANCEL_RATE = 8;

export interface NadoWriteBudget {
  placeCapacity?: number;   // token-bucket burst for order submits (nado:place, per subaccount)
  placeWindowMs?: number;   // window over which `placeCapacity` refills
  restCapacity?: number;    // burst for cancels / misc writes (nado:rest, per IP)
  restWindowMs?: number;
}

export function registerNadoWriteBuckets(limiter: RateLimiter, budget: NadoWriteBudget = {}): RateLimiter {
  const placeCapacity = budget.placeCapacity ?? NADO_PLACE_RATE;
  const placeWindowMs = budget.placeWindowMs ?? 1000;   // refills NADO_PLACE_RATE/sec at burst=capacity
  const restCapacity = budget.restCapacity ?? NADO_CANCEL_RATE;
  const restWindowMs = budget.restWindowMs ?? 1000;
  return limiter.register([
    { bucket: "nado:place", scope: "subaccount", algo: "token-bucket", capacity: placeCapacity, windowMs: placeWindowMs },
    { bucket: "nado:rest", scope: "ip", algo: "token-bucket", capacity: restCapacity, windowMs: restWindowMs },
  ]);
}
