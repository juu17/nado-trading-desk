// GET /api/nado/dda?owner=0x… — the per-subaccount DIRECT DEPOSIT ADDRESS (DDA) for a wallet's
// "default" subaccount, read from Nado's KEYLESS indexer. The indexer lives on a DIFFERENT host
// (…/archive) than the engine relay (…/gateway) and refuses cross-origin browser calls, so the tab
// asks this server route, which forwards a public query (no key). Send USDT0 to this address to
// credit that subaccount — an alternative to the Endpoint.depositCollateral on-chain call.
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { IndexerClient, INDEXER_CLIENT_ENDPOINTS } from "@nadohq/indexer-client";
import { CHAIN_ID_TO_CHAIN_ENV } from "@nadohq/client";
import { chainIdFromCookieHeader } from "../../../lib/chainEnv"; // per-request network from the cookie

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One IndexerClient per chain-env, created lazily — the network is per-request now (cookie).
const indexerByEnv = new Map<string, IndexerClient>();
function indexerFor(chainId: number): IndexerClient | null {
  const env = CHAIN_ID_TO_CHAIN_ENV[chainId];
  if (!env) return null;
  let c = indexerByEnv.get(env);
  if (!c) { c = new IndexerClient({ url: INDEXER_CLIENT_ENDPOINTS[env] }); indexerByEnv.set(env, c); }
  return c;
}

function enabled(): boolean { return process.env.NADO_LIVE === "1" || process.env.NADO_LIVE === "true"; }

export async function GET(req: Request): Promise<NextResponse> {
  if (!enabled()) return NextResponse.json({ error: "live mode disabled (NADO_LIVE unset)" }, { status: 503 });
  const chainId = chainIdFromCookieHeader(req.headers.get("cookie"));
  const indexer = indexerFor(chainId);
  if (!indexer) return NextResponse.json({ error: `no Nado indexer for chainId ${chainId}` }, { status: 500 });
  const owner = new URL(req.url).searchParams.get("owner");
  if (!owner || !isAddress(owner)) return NextResponse.json({ error: "owner must be a 0x address" }, { status: 400 });
  try {
    const { address } = await indexer.getSubaccountDDA({ subaccount: { subaccountOwner: owner, subaccountName: "default" } });
    return NextResponse.json({ address });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
