// =============================================================================
// KEYLESS live config (client). Fetches the public market/product map + endpoint +
// chainId + ws url from /api/nado/state (which no longer touches any key). This is all
// the browser needs to run the in-tab live path; the COHORT itself comes from in-tab
// custody, not from here. Cached per page load.
// =============================================================================
import type { Market } from "@farm/adapter-api";

export interface LiveProductVM {
  marketId: string; productId: number; symbol: string; kind: "perp" | "spot";
  tickSize: string; stepSize: string; minSize: string;
  minNotional?: string; // HUMAN min order notional (USDT0); absent on offline-mock products
}

export interface LiveConfig {
  enabled: boolean;
  chainId?: number;
  endpoint?: string;
  wsSubscribeUrl?: string;
  defaultProduct?: LiveProductVM;
  markets?: Market[];
  products?: LiveProductVM[];
  error?: string;
}

let cfgP: Promise<LiveConfig> | null = null;

export function getLiveConfig(force = false): Promise<LiveConfig> {
  if (force) cfgP = null;
  if (!cfgP) {
    cfgP = fetch("/api/nado/state", { cache: "no-store" })
      .then((r) => r.json() as Promise<LiveConfig>)
      .catch((e) => { cfgP = null; return { enabled: false, error: e instanceof Error ? e.message : String(e) }; });
  }
  return cfgP;
}

/** Look up a product by marketId (falls back to the default product). */
export function productFor(cfg: LiveConfig, marketId?: string): LiveProductVM | undefined {
  if (marketId) {
    const p = (cfg.products ?? []).find((x) => x.marketId === marketId);
    if (p) return p;
  }
  return cfg.defaultProduct;
}
