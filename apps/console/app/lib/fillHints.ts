// =============================================================================
// Console bridge: wire a wallet's authed `order_update` WS to the engine's fill-hint
// router (the P0-4 "orderUpdateStream → fillHints/nudge" seam). The stream is per-
// wallet, so the owner is the CONNECTION's `subaccount` — the router resolves it to
// the (campaign, pair) and calls coordinator.nudge, waking the pair so its counterpart
// follows at once (cutting fill→follow latency, half the headline metric).
//
// ⚠️ TRANSPORT CAVEAT (surfaced for Phase A): order_update emits placed/cancelled/
// filled, but this bridge wakes on EVERY event — including the "placed" ack of the
// maker just posted — so it OVER-NUDGES, each spurious wake costing one exchange read
// against a tight single-IP budget. The coordinator tolerates it (nudge re-reads
// facts; a wrong/late hint changes nothing), but under max-throughput it is wasteful.
// The intern's own wake path used Nado's KEYLESS PUBLIC `fill` stream (fill-only,
// multiplexed across the whole working set, no per-wallet auth) + a subaccount→pair
// map — a better fit for the read budget + single-IP. The core seam is subaccount-
// keyed precisely so Phase A can swap this bridge for a public-`fill`-stream one with
// no engine changes. RECOMMENDED: adopt the public `fill` stream in Phase A.
// =============================================================================
import { FillHintRouter } from "@farm/core";
import type { FillHintRegistry, NudgeSink, FillHintRouterOptions } from "@farm/core";
import { openOrderUpdateStream } from "./orderUpdateStream";
import type { OrderUpdateHandle } from "./orderUpdateStream";

export function connectFillHints(
  opts: {
    url: string;
    walletId: string;
    subaccount: string;
    endpoint: string;
    chainId: number;
    onStatus?: (s: "open" | "authed" | "closed" | "error") => void;
  },
  registry: FillHintRegistry,
  sink: NudgeSink,
  routerOpts?: FillHintRouterOptions,
): OrderUpdateHandle {
  const router = new FillHintRouter(registry, sink, routerOpts);
  // The owner is the connection's subaccount (the per-wallet stream event carries only
  // {digest, amount, reason}, never the owner). Wake on each event; see the over-nudge
  // caveat above.
  return openOrderUpdateStream({ ...opts, onEvent: () => router.onFill(opts.subaccount) });
}
