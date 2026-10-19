// GET /api/nado/state — the browser's KEYLESS window into LIVE mode. {enabled:false}
// when NADO_LIVE is unset. When enabled, returns ONLY public config (chainId, endpoint,
// ws url, the market/product map) — NO cohort, NO wallets, NO key material. The cohort
// now lives in the OPERATOR'S TAB (in-browser custody): the browser builds its own live
// fleet from the unlocked in-tab cohort and reads per wallet through the keyless relay.
// This is the custody graduation — the server no longer enumerates or unlocks any key.
import { NextResponse } from "next/server";
import { publicConfig, liveEnabled } from "../_live";
import { chainIdFromCookieHeader } from "../../../lib/chainEnv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!liveEnabled()) return NextResponse.json({ enabled: false });
  try {
    const cfg = await publicConfig(chainIdFromCookieHeader(req.headers.get("cookie")));
    return NextResponse.json({
      enabled: true,
      chainId: cfg.chainId,
      endpoint: cfg.endpoint,
      wsSubscribeUrl: cfg.wsSubscribeUrl,
      defaultProduct: cfg.defaultProduct,
      markets: cfg.markets,
      products: cfg.products, // [{marketId, productId, symbol, kind, tickSize, stepSize, minSize, minNotional}]
    });
  } catch (e) {
    return NextResponse.json({ enabled: true, error: e instanceof Error ? e.message : String(e) });
  }
}
