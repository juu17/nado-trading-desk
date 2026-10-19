// =============================================================================
// SERVER-ONLY live config root (Node runtime). After the Stage 2b custody graduation
// the server holds NO per-wallet key and does NO signing or broadcasting. ALL custody
// lives in the operator's tab:
//   • orders + funding (deposit/withdraw) build + sign IN-TAB and go to the keyless relay
//     (deposit broadcasts straight to the Ink RPC via a keyless ChainClient),
//   • reads go through the keyless relay,
//   • this module serves ONLY public, keyless config (the market/product map + endpoint +
//     ws url) via a query-only EngineClient — no Workspace unlock, no key.
//
// The ONE remaining Workspace.open is dumpFundedMnemonic — the DEV-ONLY seed bridge
// (localhost + NADO_DEV_SEED gated) that hands the disposable funded mnemonic to the tab
// for live verification. It dumps a MNEMONIC for in-tab import, never a per-wallet
// private key, and is not part of the production custody model. Gated by NADO_LIVE=1.
// =============================================================================
import "server-only";
import "wative-core/node";
import { Workspace } from "wative-core";
import type { Market, MarketId, ChainId, Decimal, Bps } from "@farm/adapter-api";
import { nadoMarketSizing } from "@farm/adapter-nado";
import { EngineClient, ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS } from "@nadohq/engine-client";
import { NADO_DEPLOYMENTS, CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS } from "@nadohq/client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Keeps the project's FORMER name (Nado-ika) on purpose: the encrypted testnet workspace already lives
// at ~/.nado-ika-testnet (outside the repo; the adapter scripts read the same path). Do not rename it
// without moving that directory in the same change.
const CRED_PATH = join(homedir(), ".nado-ika-testnet", "credentials.json");

export function liveEnabled(): boolean {
  return process.env.NADO_LIVE === "1" || process.env.NADO_LIVE === "true";
}

interface BigNumberish { toFixed(dp?: number): string }
const x18 = (v: BigNumberish): bigint => BigInt(v.toFixed(0));
// Nado getSymbols unit conventions (verified live 2026-10-18; see adapter-nado/sizing.ts):
// priceIncrement = HUMAN tick; sizeIncrement = X18 base-asset step; `minSize` is MISNAMED —
// it is the min ORDER NOTIONAL in X18 USDT0 (uniform across markets), NOT a base-asset size.
// nadoMarketSizing() applies the correct interpretation (base min = one step; min notional
// from the `minSize` field) — previously minSize was read as a base size, inflating every
// order ~10,000× via clampSize.
const humanStr = (v: BigNumberish | string | number): string =>
  typeof v === "object" && v && "toFixed" in v ? v.toFixed() : String(v);
const humanNum = (v: BigNumberish | string | number | undefined): number => (v == null ? 0 : Number(humanStr(v)));

export interface LiveProduct {
  marketId: MarketId; productId: number; symbol: string; kind: "perp" | "spot";
  tickSize: Decimal; stepSize: Decimal; minSize: Decimal; minNotional: Decimal;
}

// ---- KEYLESS public config (NO workspace unlock; markets via a public query) --------
// The browser needs the market map + endpoint + ws url to run the client-side live path
// (in-tab sign → keyless relay; in-tab on-chain deposit). None of it is secret, so this
// builds WITHOUT touching the workspace or any key.
export interface PublicConfig {
  chainId: number; endpoint: string; engineUrl: string; wsSubscribeUrl: string;
  markets: Market[]; productIds: Record<MarketId, number>;
  byMarketId: Map<string, LiveProduct>; byProductId: Map<number, LiveProduct>;
  defaultProduct: LiveProduct; products: LiveProduct[];
}

// Cache the public config PER chainId — the network is per-request now (resolved from the cookie).
const publicCfgByChain = new Map<number, Promise<PublicConfig>>();
export function publicConfig(chainId: number): Promise<PublicConfig> {
  let p = publicCfgByChain.get(chainId);
  if (!p) { p = buildPublicConfig(chainId).catch((e) => { publicCfgByChain.delete(chainId); throw e; }); publicCfgByChain.set(chainId, p); }
  return p;
}

async function buildPublicConfig(chainId: number): Promise<PublicConfig> {
  if (!liveEnabled()) throw new Error("live mode is disabled (set NADO_LIVE=1)");
  const env = CHAIN_ID_TO_CHAIN_ENV[chainId];
  if (!env) throw new Error(`no Nado chain-env for chainId ${chainId}`);
  const deploy = NADO_DEPLOYMENTS[env];
  const engineUrl = ENGINE_CLIENT_ENDPOINTS[env];
  const engine = new EngineClient({ url: engineUrl }); // keyless: query-only

  const symResp = (await engine.getSymbols({})) as unknown as { symbols: Record<string, {
    type: unknown; productId: number; symbol: string;
    priceIncrement: BigNumberish; sizeIncrement: BigNumberish; minSize: BigNumberish;
    makerFeeRate?: BigNumberish; takerFeeRate?: BigNumberish;
  }> };
  const markets: Market[] = [];
  const productIds: Record<MarketId, number> = {};
  const byMarketId = new Map<string, LiveProduct>();
  const byProductId = new Map<number, LiveProduct>();
  for (const s of Object.values(symResp.symbols)) {
    const kind: "perp" | "spot" = Number(s.type) === 1 ? "perp" : "spot";
    const marketId = `nado:${kind}:${s.symbol}` as MarketId;
    const base = s.symbol.split(/[-/]/)[0] ?? s.symbol;
    // Correct unit interpretation: base min = one size increment; the `minSize` field is a
    // USDT0 NOTIONAL floor (not a base size). See adapter-nado/sizing.ts.
    const sizing = nadoMarketSizing(humanStr(s.priceIncrement), x18(s.sizeIncrement), x18(s.minSize));
    const prod: LiveProduct = {
      marketId, productId: Number(s.productId), symbol: s.symbol, kind,
      tickSize: sizing.tickSize as Decimal,
      stepSize: sizing.stepSize as Decimal,
      minSize: sizing.minSize as Decimal,
      minNotional: sizing.minNotional as Decimal,
    };
    markets.push({
      id: marketId, chainId: chainId as ChainId, product: kind, base, quote: "USDT0",
      tickSize: prod.tickSize, stepSize: prod.stepSize, minNotional: prod.minNotional,
      makerFeeBps: Math.round(humanNum(s.makerFeeRate) * 10000) as Bps,
      takerFeeBps: Math.round(humanNum(s.takerFeeRate) * 10000) as Bps,
      raw: s,
    });
    productIds[marketId] = prod.productId;
    byMarketId.set(marketId, prod);
    byProductId.set(prod.productId, prod);
  }
  if (markets.length === 0) throw new Error("no live markets returned by the sequencer");
  const wantPid = Number(process.env.NADO_LIVE_PRODUCT_ID || 2);
  const defaultProduct = byProductId.get(wantPid) ?? byProductId.get([...byProductId.keys()][0] as number)!;

  return {
    chainId, endpoint: deploy.endpoint, engineUrl,
    wsSubscribeUrl: ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS[env],
    markets, productIds, byMarketId, byProductId, defaultProduct, products: [...byMarketId.values()],
  };
}

/** Dev-only (localhost + NADO_DEV_SEED): the funded disposable mnemonic, so the operator's
 *  tab can IMPORT the already-funded+deposited cohort for live verification. This is a
 *  VERIFICATION convenience, not the production custody model — the product operator
 *  brings their own seed. It dumps a MNEMONIC (for in-tab import), never a per-wallet
 *  private key; never logged; returned only to a same-host caller. This is the SOLE
 *  remaining Workspace.open on the server. */
export async function dumpFundedMnemonic(): Promise<string> {
  // Self-protecting: the secret-dumping primitive refuses unless the dev gate is explicitly
  // ON, regardless of caller — so a future second caller that forgets the route's gates can't
  // leak the funded seed. This is the in-function guard the route's checks sit on top of.
  if (!liveEnabled() || process.env.NADO_DEV_SEED !== "1") throw new Error("dev-seed disabled");
  const cred = JSON.parse(await readFile(CRED_PATH, "utf8")) as { workspacePath: string; password: string };
  const ws = await Workspace.open({ path: cred.workspacePath, password: cred.password });
  const acc = ws.accounts[0] as unknown as { tryUnlock(p: string): Promise<unknown>; dumpMnemonic(): string } | undefined;
  if (!acc) throw new Error("no account in the testnet workspace");
  await acc.tryUnlock(cred.password);
  return acc.dumpMnemonic();
}
