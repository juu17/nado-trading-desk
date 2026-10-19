// =============================================================================
// Browser-side live stream to the sequencer's /subscribe endpoint. The `fill` +
// `position_change` streams are PUBLIC (subscribe by subaccount hex — no key), so the
// browser opens them directly. `order_update` is auth-gated (a signed WS `authenticate`
// per connection) — it signs IN-TAB and streams direct from the browser, keyless, with no
// relay; it is handled separately in orderUpdateStream.ts (W5).
// Protocol: { id, method: "subscribe", stream: { type, subaccount } }.
// =============================================================================
export interface LiveEvent {
  type: "order_update" | "fill" | "position_change" | string;
  subaccount?: string; // the affected subaccount — public fill/position_change carry it; order_update is socket-scoped
  digest?: string;
  amount?: string;
  reason?: string;
  ts: number;
  raw: unknown;
}

export interface LiveStreamHandle { close: () => void }

// Streams the browser can subscribe to without auth, for EVERY cohort subaccount over this one
// socket (they scale like the single public socket — RE-proven). `fill` gives trade fills;
// `position_change` gives non-fill position moves (deposit/withdraw collateral, settle_pnl,
// liquidation) a fill never surfaces — both route (by their `subaccount`) to a targeted reconcile
// in page.tsx. `order_update` is auth-gated (per-connection) and handled separately (W5).
const PUBLIC_STREAMS = ["fill", "position_change"] as const;

export function openLiveStream(opts: {
  url: string;
  subaccounts: string[];
  onEvent: (e: LiveEvent) => void;
  onStatus?: (s: "open" | "closed" | "error") => void;
}): LiveStreamHandle {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let idc = 1;

  const connect = (): void => {
    if (closed) return;
    try { ws = new WebSocket(opts.url); } catch { scheduleReconnect(); return; }
    ws.onopen = () => {
      retry = 0;
      opts.onStatus?.("open");
      // subscribe each PUBLIC_STREAMS type for EACH cohort subaccount, over one WS
      for (const subaccount of opts.subaccounts) {
        for (const type of PUBLIC_STREAMS) {
          try { ws?.send(JSON.stringify({ id: idc++, method: "subscribe", stream: { type, subaccount } })); } catch { /* ignore */ }
        }
      }
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
        const t = (m["type"] ?? m["method"]) as string | undefined;
        if (t === "order_update" || t === "fill" || t === "position_change") {
          opts.onEvent({
            type: t,
            // fill carries `subaccount` + `order_digest`; position_change carries `subaccount`;
            // order_update carries neither (it is scoped to the authed socket's wallet).
            subaccount: m["subaccount"] as string | undefined,
            digest: (m["digest"] ?? m["order_digest"]) as string | undefined,
            amount: (m["amount"] ?? m["filled_qty"]) as string | undefined,
            reason: m["reason"] as string | undefined,
            ts: Date.now(), raw: m,
          });
        }
      } catch { /* non-JSON / ping — ignore */ }
    };
    ws.onclose = () => { opts.onStatus?.("closed"); scheduleReconnect(); };
    ws.onerror = () => { opts.onStatus?.("error"); };
  };

  const scheduleReconnect = (): void => {
    if (closed) return;
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * 2 ** retry); // 1s → ~32s backoff
  };

  connect();
  return { close: () => { closed = true; try { ws?.close(); } catch { /* ignore */ } } };
}
