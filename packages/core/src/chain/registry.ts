// =============================================================================
// @farm/core · chain registry — WRAPS wative's network registry, never rebuilds it.
//
// Retro-audit (2026-10-16): the superseded `StaticChainRegistry` draft hand-built
// a Map + hardcoded Ink mainnet (57073) + explorer URLs. wative already ships
// `Network.Ink` as a builtin (chainId 57073, rpcUrl, native ETH) plus `Network.all()`
// and the live `Workspace.networks` (`NetworkCollection.byChainId`). This registry
// PROJECTS those wative `Network`s into the seam's `ChainSpec`, overlaying ONLY what
// wative lacks: rate-limit buckets, the re-broadcast policy, and testnet/explorer
// flags. The ONLY non-builtin network we add is Ink *testnet* (763373), and even
// that is a wative `Network` instance — not a hand-rolled spec.
// =============================================================================
import { Network } from "wative-core";
import type {
  ChainRegistry, ChainSpec, ChainId, ChainFamily, RateLimitSpec,
  BroadcastPolicy, FeePolicy, AdapterError,
} from "@farm/adapter-api";

/** Per-chain overlay: the facts wative's `Network` does not carry. */
export interface ChainOverlayEntry {
  rateLimits?: readonly RateLimitSpec[];
  broadcast?: BroadcastPolicy;
  fee?: FeePolicy;
  testnet?: boolean;
  blockExplorerUrl?: string;
  hidden?: boolean;
  /** Operator RPC override (env-wired); falls back to the wative Network endpoints. */
  rpc?: { read?: readonly string[]; broadcast?: readonly string[] };
}
export interface ChainOverlay {
  default?: ChainOverlayEntry;                   // applied to every chain
  byChainId?: Readonly<Record<string, ChainOverlayEntry>>;
}

/** Conservative default RPC buckets so the metered transport rations 1000 wallets
 *  against one shared RPC / egress IP (D3). verifiedOnTestnet:false — they rot. */
export function defaultRpcBuckets(chainId: ChainId): RateLimitSpec[] {
  const id = String(chainId);
  return [
    { bucket: `rpc:read:${id}`, scope: "chain", algo: "token-bucket", capacity: 1200, windowMs: 60_000, verifiedOnTestnet: false },
    { bucket: `rpc:broadcast:${id}`, scope: "chain", algo: "token-bucket", capacity: 600, windowMs: 60_000, burst: { capacity: 100, windowMs: 10_000 }, verifiedOnTestnet: false },
  ];
}

/** Default broadcast policy: wative's `ChainClient.broadcast` is single-attempt;
 *  the core plan runner owns bounded re-broadcast, reconciling by hash first. */
export const DEFAULT_BROADCAST: BroadcastPolicy = {
  singleAttempt: true,
  maxReattempts: 3,
  confirmations: 1,
  lookupBeforeRetry: true,
};

const INK_TESTNET_CHAIN_ID = 763373;

/** Map wative `VmToken` → the seam's `ChainFamily`; `null` for an unsupported vm. */
function toFamily(vm: string): ChainFamily | null {
  return vm === "evm" || vm === "svm" ? vm : null;
}

/** Project ONE wative `Network` + its overlay into a seam `ChainSpec`. */
export function projectNetwork(network: Network, overlay: ChainOverlay): ChainSpec | null {
  const family = toFamily(network.vm);
  if (!family) return null; // skip vms the seam doesn't model (none today)
  const chainId = network.chainId as unknown as ChainId;
  const entry: ChainOverlayEntry = {
    ...overlay.default,
    ...overlay.byChainId?.[String(chainId)],
  };
  const read = entry.rpc?.read ?? network.endpointsFor("read");
  const broadcast = entry.rpc?.broadcast ?? network.endpointsFor("write");
  return {
    chainId,
    family,
    displayName: network.name,
    hidden: entry.hidden,
    nativeAsset: { symbol: network.nativeCurrency.symbol, decimals: network.nativeCurrency.decimals },
    rpc: { read: [...read], broadcast: [...broadcast] },
    fee: entry.fee,
    broadcast: entry.broadcast ?? DEFAULT_BROADCAST,
    rateLimits: entry.rateLimits ?? defaultRpcBuckets(chainId),
    blockExplorerUrl: entry.blockExplorerUrl,
    testnet: entry.testnet,
  };
}

/** Registry over a set of wative `Network`s, eager-projected to `ChainSpec`. */
export class WativeChainRegistry implements ChainRegistry {
  private readonly byId = new Map<string, ChainSpec>();

  constructor(networks: readonly Network[], overlay: ChainOverlay = {}) {
    for (const n of networks) {
      const spec = projectNetwork(n, overlay);
      if (spec) this.byId.set(String(spec.chainId), spec);
    }
  }

  /** Build from wative's static builtins (`Network.all()`, incl. `Network.Ink`). */
  static fromBuiltins(overlay: ChainOverlay = {}): WativeChainRegistry {
    return new WativeChainRegistry(Network.all(), overlay);
  }

  get(id: ChainId): ChainSpec | undefined { return this.byId.get(String(id)); }
  has(id: ChainId): boolean { return this.byId.has(String(id)); }
  require(id: ChainId): ChainSpec {
    const s = this.byId.get(String(id));
    if (!s) {
      const err: AdapterError = {
        category: "network", retrySafe: false,
        message: `chainId ${String(id)} is not registered`,
        code: "CHAIN_NOT_REGISTERED", raw: { chainId: id },
      };
      throw Object.assign(new Error(err.message), err);
    }
    return s;
  }
  byFamily(family: ChainFamily): ChainSpec[] {
    return [...this.byId.values()].filter((s) => s.family === family);
  }
  list(): ChainSpec[] { return [...this.byId.values()].filter((s) => !s.hidden); }
  all(): ChainSpec[] { return [...this.byId.values()]; }
}

/**
 * Ink *testnet* (763373) as a wative `Network` — NOT a wative builtin, so we
 * construct one (still a real `Network`, not a hand-rolled ChainSpec). The RPC
 * URL is operator-supplied (env); never baked into source.
 */
export function inkTestnetNetwork(rpcUrl: string): Network {
  return new Network("Ink Sepolia", INK_TESTNET_CHAIN_ID, rpcUrl, {
    name: "Ether", symbol: "ETH", decimals: 18,
  });
}

/**
 * Default overlay: op-stack broadcast + RPC buckets for all chains, Ink testnet
 * flagged testnet + explorer, Solana networks hidden (A4, modeled but deferred).
 * apps/console merges operator RPC overrides on top.
 */
export function defaultChainOverlay(): ChainOverlay {
  return {
    byChainId: {
      "57073": { blockExplorerUrl: "https://explorer.inkonchain.com" },
      [String(INK_TESTNET_CHAIN_ID)]: { testnet: true, blockExplorerUrl: "https://explorer-sepolia.inkonchain.com" },
      // Solana builtins modeled but hidden until an SVM adapter lands (A4).
      "7565164": { hidden: true },
      "7565166": { hidden: true },
      "7565165": { hidden: true },
    },
  };
}
