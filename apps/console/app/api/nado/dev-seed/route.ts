// GET /api/nado/dev-seed — DEV-ONLY bridge: hands the funded disposable testnet seed to
// the operator's tab so it can IMPORT the already-funded+deposited cohort for live
// verification. This is a VERIFICATION convenience, NOT the production custody model (the
// real operator brings their own seed in their tab). Gated by an explicit NADO_DEV_SEED=1
// opt-in (off in any normal/prod run) + NADO_LIVE, backed by dumpFundedMnemonic's own
// self-guard; a best-effort localhost check is defense-in-depth, not a security boundary
// (the Host header is spoofable). The seed is never logged, never committed, never echoed in
// an error.
import { NextResponse } from "next/server";
import { liveEnabled, dumpFundedMnemonic } from "../_live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Best-effort localhost check — NOT a security boundary (the Host header is client-controlled
// and spoofable). The REAL gates are NADO_DEV_SEED=1 (off in any normal/prod run), the dev/start
// server binding to loopback (next -H 127.0.0.1, see package.json), and dumpFundedMnemonic's own
// self-guard. We drop the old empty-Host allow-branch (empty ⇒ not local). We do NOT key on
// x-forwarded-* — Next injects those on every direct request, so that would 403 the real flow.
function isLocal(req: Request): boolean {
  const host = (req.headers.get("host") ?? "").split(":")[0];
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

export async function GET(req: Request) {
  if (!liveEnabled()) return NextResponse.json({ error: "live mode disabled" }, { status: 503 });
  if (process.env.NADO_DEV_SEED !== "1") return NextResponse.json({ error: "dev-seed bridge disabled (set NADO_DEV_SEED=1)" }, { status: 403 });
  if (!isLocal(req)) return NextResponse.json({ error: "dev-seed is localhost-only" }, { status: 403 });
  try {
    const mnemonic = await dumpFundedMnemonic();
    return NextResponse.json({ mnemonic }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    // Never echo the underlying error text (it touches the seed/workspace and could carry a
    // seed/password fragment) to the caller OR the logs. Log only the error CLASS so a dev can
    // tell "missing creds" from "bad password" without any secret surfacing.
    console.error(`[dev-seed] unavailable (${e instanceof Error ? e.name : "unknown"}) — check NADO_DEV_SEED=1 + ~/.nado-ika-testnet`);
    return NextResponse.json({ error: "dev-seed unavailable" }, { status: 500 });
  }
}
