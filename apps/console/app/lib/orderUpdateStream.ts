// =============================================================================
// AUTHED order_update WS (Scaling W5). The sequencer gates the real-time order-state stream
// (placed / cancelled / filled — richer than the public `fill` stream) behind a signed
// StreamAuthentication `authenticate` frame. We sign it IN-TAB (wative, via the in-tab signer),
// so the server stays keyless and the WS goes DIRECT from the browser (not CORS-blocked, no
// relay). It is PER-WALLET / PER-CONNECTION (a socket authed as wallet A can't read B), so it is
// opened only for a bounded WORKING SET (today: the open drawer wallet), NOT the whole cohort.
// Re-auth happens on (re)connect only; a dropped socket reconnects + re-signs. On auth error we
// close and let the budget-paced sweep remain the backstop.
// =============================================================================
import { buildStreamAuthTypedData } from "@farm/adapter-nado";
import { signerForWalletId } from "./custody";

export interface OrderUpdateEvent { digest?: string; amount?: string; reason?: string }
export interface OrderUpdateHandle { close: () => void }

export function openOrderUpdateStream(opts: {
  url: string; walletId: string; subaccount: string; endpoint: string; chainId: number;
  onEvent: (e: OrderUpdateEvent) => void;
  onStatus?: (s: "open" | "authed" | "closed" | "error") => void;
}): OrderUpdateHandle {
  let ws: WebSocket | null = null;
  let closed = false;    // the caller closed us (drawer closed)
  let terminal = false;  // a DETERMINISTIC failure (can't sign / auth rejected) — do NOT reconnect
  let retry = 0;
  let idc = 1;
  let authId = 0;

  const connect = (): void => {
    if (closed || terminal) return;
    try { ws = new WebSocket(opts.url); } catch { scheduleReconnect(); return; }

    ws.onopen = () => {
      opts.onStatus?.("open");
      // Sign the StreamAuthentication IN-TAB (expiration = now + 60s, UNIX MILLISECONDS, <=100s
      // ahead) and send the authenticate frame; subscribe only after the ack.
      void (async () => {
        try {
          const expiration = String(Date.now() + 60_000);
          const signer = signerForWalletId(opts.walletId);
          const built = buildStreamAuthTypedData(opts.subaccount, expiration, { chainId: opts.chainId, endpoint: opts.endpoint });
          const signature = await signer.signTypedData!(built.typedData, opts.chainId);
          authId = idc++;
          ws?.send(JSON.stringify({ id: authId, method: "authenticate", tx: { sender: opts.subaccount, expiration }, signature }));
        } catch {
          // Can't sign (cohort locked / no in-tab signer) — reconnecting won't help, so stop.
          terminal = true; opts.onStatus?.("error"); try { ws?.close(); } catch { /* ignore */ }
        }
      })();
    };

    ws.onmessage = (ev) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      // authenticate ack: carries our authId and no stream `type`. Error => auth rejected.
      if (authId && m["id"] === authId && !("type" in m)) {
        if (m["error"]) {
          // A deterministic reject (bad sig / clock skew outside the <=100s window) won't fix
          // itself — stop reconnecting and let the budget-paced sweep + public fill backstop.
          terminal = true; opts.onStatus?.("error"); try { ws?.close(); } catch { /* ignore */ }
          return;
        }
        retry = 0; // reset backoff only on a SUCCESSFUL auth (not on a mere connect)
        opts.onStatus?.("authed");
        try { ws?.send(JSON.stringify({ id: idc++, method: "subscribe", stream: { type: "order_update", subaccount: opts.subaccount } })); } catch { /* ignore */ }
        return;
      }
      if (m["type"] === "order_update") {
        opts.onEvent({ digest: m["digest"] as string | undefined, amount: m["amount"] as string | undefined, reason: m["reason"] as string | undefined });
      }
    };

    ws.onclose = () => { opts.onStatus?.("closed"); scheduleReconnect(); };
    ws.onerror = () => { opts.onStatus?.("error"); };
  };

  const scheduleReconnect = (): void => {
    if (closed || terminal) return; // never reconnect after a deterministic auth/sign failure
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * 2 ** retry); // 1s → ~32s backoff; re-auths on the new onopen
  };

  connect();
  return { close: () => { closed = true; try { ws?.close(); } catch { /* ignore */ } } };
}
