// POST /api/nado/relay/{execute|query} — the KEYLESS relay. The browser signs in-tab
// and sends the already-signed payload here; this route forwards the bytes to the Nado
// sequencer and returns the response. It holds NO key and does no signing — it only
// exists because the sequencer refuses cross-origin browser requests (CORS 403). This
// is the custody-free server the graduation demotes the old server-key route toward.
import { NextResponse } from "next/server";
import { CHAIN_ID_TO_CHAIN_ENV, ENGINE_CLIENT_ENDPOINTS } from "@nadohq/client";
import { chainIdFromCookieHeader } from "../../../../lib/chainEnv"; // per-request network from the cookie

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOW = new Set(["execute", "query"]); // only these sequencer paths are forwardable

function enabled(): boolean {
  return process.env.NADO_LIVE === "1" || process.env.NADO_LIVE === "true";
}

// 429 retry-with-backoff. The relay is the single choke point for ALL sequencer traffic
// (reads via /query AND writes via /execute), and the sequencer rate-limits per IP — the
// Next server's egress IP, shared by the whole cohort. Bounded exponential backoff (honoring
// Retry-After when present) smooths the transient per-IP 429s a multi-wallet burst triggers,
// without masking a sustained overload (we give up after RETRY_MAX and return the 429).
const RETRY_MAX = 4;
const RETRY_BASE_MS = 400;
const RETRY_CAP_MS = 8_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// Backoff with JITTER. Without it, a cohort-wide burst that all 429s retries in lockstep at
// identical offsets (400/800/…) and re-triggers the 429 together (thundering herd). We
// decorrelate each retry by ±50% so the retries spread out instead of re-colliding.
function retryAfterMs(res: Response, attempt: number): number {
  const ra = res.headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    // Honor Retry-After as a FLOOR, then add a little jitter above it so concurrent callers
    // that all got the same header don't fire again in lockstep.
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000 + Math.floor(Math.random() * 500), RETRY_CAP_MS);
  }
  const base = RETRY_BASE_MS * 2 ** attempt; // 400 → 800 → 1600 → 3200ms
  return Math.min(Math.floor(base * (0.5 + Math.random())), RETRY_CAP_MS); // ±50% jitter around base
}

export async function POST(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  if (!enabled()) return NextResponse.json({ error: "live mode disabled (NADO_LIVE unset)" }, { status: 503 });
  const { path } = await ctx.params;
  const seg = (path ?? []).join("/");
  if (!ALLOW.has(seg)) return NextResponse.json({ error: `relay path '${seg}' not allowed` }, { status: 400 });
  // Forward to the sequencer for the SELECTED network (from the cookie), resolved per request.
  const BASE = ENGINE_CLIENT_ENDPOINTS[CHAIN_ID_TO_CHAIN_ENV[chainIdFromCookieHeader(req.headers.get("cookie"))]!];
  const body = await req.text(); // opaque: a signed execute payload or a public query
  try {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${BASE}/${seg}`, { method: "POST", headers: { "content-type": "application/json" }, body });
      if (r.status === 429 && attempt < RETRY_MAX) {
        await r.body?.cancel().catch(() => {}); // drain the rate-limit body before retrying
        await sleep(retryAfterMs(r, attempt));
        continue;
      }
      const text = await r.text();
      return new NextResponse(text, { status: r.status, headers: { "content-type": "application/json" } });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
