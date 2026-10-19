// POST /api/nado/execute — RETIRED after the Stage 2b custody graduation. Every action
// (orders AND funding) now builds + signs IN THE OPERATOR'S TAB: orders/withdraw go to the
// keyless relay (/api/nado/relay), deposit broadcasts straight to the Ink RPC via a keyless
// ChainClient. The server holds no key and signs nothing, so this route no longer executes
// anything — it is a tombstone that returns 410 Gone for every action, so a stale client
// fails loudly instead of silently hitting a dead server path. 503 unless NADO_LIVE.
import { NextResponse } from "next/server";
import { liveEnabled } from "../_live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ExecBody { action?: string }

const MOVED: Record<string, string> = {
  placeOrder: "orders sign client-side and go to /api/nado/relay",
  cancel: "orders sign client-side and go to /api/nado/relay",
  closePosition: "orders sign client-side and go to /api/nado/relay",
  deposit: "deposit builds + signs in-tab and broadcasts to the Ink RPC via a keyless ChainClient",
  withdraw: "withdraw signs in-tab (EIP-712) and goes to /api/nado/relay",
};

export async function POST(req: Request) {
  if (!liveEnabled()) return NextResponse.json({ error: "live mode disabled (NADO_LIVE unset)" }, { status: 503 });
  let body: ExecBody;
  try { body = (await req.json()) as ExecBody; } catch { return NextResponse.json({ error: "bad JSON body" }, { status: 400 }); }
  const where = body.action ? MOVED[body.action] : undefined;
  return NextResponse.json(
    { ok: false, error: `'${String(body.action)}' moved in-tab: ${where ?? "the server no longer signs or broadcasts anything"} (server is keyless)` },
    { status: 410 },
  );
}
