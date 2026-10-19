# RE findings — authenticated `order_update` WebSocket subscription

**Status:** IMPLEMENTED (scaling W5). Cracked end-to-end, proven live on Ink testnet, and shipped in `apps/console/app/lib/orderUpdateStream.ts` (builder `buildStreamAuthTypedData` in `packages/adapter-nado/src/execute.ts`).
**Verdict:** ✅ **Feasible, and in-tab signable with the server staying keyless.** No relay or
server change is required for the stream itself.
**Scope caveat:** 🎯 auth is **per-wallet, per-connection** — this does *not* scale like the
single public `fill` socket. See "Fleet-scaling constraint".

Date: 2026-10-16. Chain: Ink testnet (chainId `763373`). Sequencer: `api.test.nado.xyz`.

---

## 1. TL;DR

- Only **one** subscription stream is authenticated: `order_update`. The other ten streams —
  including `fill` and `position_change`, which also carry per-subaccount private data — are
  **public** (subscribe by subaccount hex, no auth). This was confirmed both by the official docs
  and by a live probe.
- To read `order_update`, the client sends an **`authenticate`** control frame on the *same*
  `/subscribe` socket **before** subscribing. The frame carries an EIP-712 signature over a
  `StreamAuthentication(bytes32 sender, uint64 expiration)` struct.
- The signature is an ordinary Nado-domain EIP-712 sign — **the exact kind wative-core already
  produces in-tab** (byte-equal to the Nado SDK, proven in wave 1a). So the operator's key signs
  the auth **in the tab**; the server never sees a key.
- The `/subscribe` WebSocket already works **direct from the browser** today (the public `fill`
  stream is opened in-tab). WebSocket upgrades are not CORS-blocked the way the sequencer's REST
  `/execute` + `/query` are (that CORS 403 is why the keyless REST relay exists). So the
  authenticated `order_update` also goes **direct from the browser** — **no relay involvement**.
- **Correction of the prior premise:** the console's deferral comment
  (`apps/console/app/lib/liveStream.ts`) says order_update "requires a signed WS `authenticate`
  (a server-side session)" and that its auth is undocumented. The first half is right (it needs a
  signed `authenticate`); the "server-side session" framing is **wrong** — it is a per-connection,
  client-signed auth that stays in-tab, and it **is** documented (see §8).

---

## 2. Endpoints

| Purpose | URL |
|---|---|
| Subscription streams (public + `order_update`) | `wss://api.test.nado.xyz/gateway/v1/subscribe` |
| Execute-over-WS (place/cancel) — *not used here* | `wss://api.test.nado.xyz/gateway/v1/ws` |
| REST execute/query (via keyless relay) | `https://api.test.nado.xyz/gateway/v1` |

From `@nadohq/engine-client` `endpoints.js`: `ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS.inkTestnet`.
The console already exposes this to the browser as `wsSubscribeUrl` and opens it directly.

Valid control methods on `/subscribe` (from the server itself):
`authenticate, subscribe, subscribe_multi, unsubscribe, unsubscribe_multi, list, ping, time`.

---

## 3. The authenticated-subscribe protocol (exact wire shapes)

### 3.1 Step 1 — authenticate the connection

```json
{
  "id": 1,
  "method": "authenticate",
  "tx": {
    "sender": "0x<bytes32 subaccount hex>",
    "expiration": "<unix MILLISECONDS, as a string>"
  },
  "signature": "0x<65-byte EIP-712 signature>"
}
```

- `tx.sender` — the 32-byte subaccount hex: `owner(20 bytes) ++ subaccountName(12 bytes, utf8,
  right-zero-padded)`. Build it with `subaccountToHex({ subaccountOwner, subaccountName })` from
  `@nadohq/client` (the console already uses this helper in `custody.ts`).
- `tx.expiration` — **milliseconds** since epoch, as a string. Must be **in the future** and
  **≤ 100 s ahead** of server time, or the server rejects it (the engine phrases an out-of-window
  value as `Request received after 'recv_time'`). ⚠️ Note the unit: `expiration` here is **ms**,
  whereas order `expiration` elsewhere in the SDK is **seconds**.
- `signature` — EIP-712 signature (see §4).

Success response: `{"result": null, "id": 1}`. Failure: `{"result": null, "error": "...", "id": 1}`.

### 3.2 Step 2 — subscribe `order_update` (same socket, after auth)

```json
{
  "id": 2,
  "method": "subscribe",
  "stream": { "type": "order_update", "subaccount": "0x<bytes32 subaccount hex>", "product_id": 1 }
}
```

`product_id` is optional (omit → all products). The subscribe message is *identical in shape* to
the public `fill` subscribe — the only difference is the server requires the connection to be
authenticated first. Success: `{"result": null, "id": 2}`.

### 3.3 `order_update` event frames

```jsonc
{ "type": "order_update", "timestamp": "<ns>", "product_id": 2,
  "digest": "0x<order digest>", "amount": "<x18>", "reason": "placed" }   // reason ∈ placed | filled | cancelled
```

(Type: `EngineServerSubscriptionOrderUpdateEvent` in `@nadohq/engine-client`
`serverSubscriptionEventTypes`.) Note `order_update` frames do **not** repeat `subaccount` — the
stream is scoped to the subaccount/wallet you authenticated + subscribed as.

---

## 4. What is signed — EIP-712 `StreamAuthentication`

```solidity
struct StreamAuthentication {
    bytes32 sender;      // the subaccount hex (same as tx.sender)
    uint64  expiration;  // SIGN as uint64; SEND in tx as a string
}
```

- **Domain** (`getNadoEIP712Domain`): `{ name: "Nado", version: "0.0.1", chainId: 763373,
  verifyingContract: <endpoint> }`.
- **verifyingContract** = the Nado **endpoint** address (`NADO_DEPLOYMENTS.inkTestnet.endpoint`
  = `0x698D87105274292B5673367DEC81874Ce3633Ac2` on testnet).
- **primaryType** = `StreamAuthentication`.
- **message** = `{ sender, expiration: BigInt(expiration) }`.
- The signer must be the wallet that `sender` names (the subaccount owner). A `link_signer`
  delegate would presumably also work (the docs say "the wallet address that `sender` specifies");
  not needed here — the operator's own key is in the tab.

🔎 The installed `@nadohq/*` **0.58.0** SDK does **not** export a `StreamAuthentication` builder
(no `stream_authentication` case in `getNadoEIP712Types`; the WS subscription client only builds
`{ id, method, stream }`). This absence is exactly why the earlier wave believed the auth was
"undocumented". The typed data is trivial to hand-build (4 lines), and because it uses the
standard Nado domain, wative-core's generic `signTypedData` signs it in-tab with no new SDK
support. (The related `nado_authentication` / `NadoAuthentication` type *is* in the SDK, but that
is the **mobile-REST** request-signing scheme — `{ method, sender, payloadHash, nonce }` — and is
**not** what `/subscribe` wants. Don't conflate them.)

---

## 5. Live proof (Ink testnet)

A throwaway spike (`packages/adapter-nado/scripts/order-update-probe.mjs`) authenticated the
`/subscribe` socket with the disposable funded wallet, subscribed `order_update`, then placed a
`post_only` maker order and cancelled it. Signature produced via viem `signTypedData` — the same
EIP-712 path wative-core uses in-tab. Observed:

```
AUTH OK: {"result":null,"id":1}
ORDER_UPDATE SUBSCRIBED: {"result":null,"id":2}
ORDER_UPDATE FRAME: {"type":"order_update","timestamp":"...","product_id":2,"digest":"0x…","amount":"100000000000000000000","reason":"placed"}
ORDER_UPDATE FRAME: {"type":"order_update","timestamp":"...","product_id":2,"digest":"0x…","amount":"0","reason":"cancelled"}
=== RESULT === authed=true order_update_subscribed=true frames=2
```

So: auth works, subscribe works, and real `placed` / `cancelled` frames arrive. The order was
cancelled in the same run; nothing left resting.

---

## 6. 🎯 Fleet-scaling constraint (the important design finding)

Auth is **per-wallet and per-connection**, not per-subaccount and not socket-wide:

- Authenticating `sender` authenticates the **whole wallet** — all of that wallet's subaccounts'
  `order_update` streams become available on that connection.
- But a connection authenticated as wallet **A** **cannot** read wallet **B**'s `order_update`.
  Verified live: on a socket authed as our wallet, subscribing `order_update` for a *foreign*
  subaccount returned `authentication for 0x7a5e…7c43 required`.
- "Once a connection is authenticated, its status can't change for the rest of that connection"
  (docs) — i.e. one socket = one authenticated wallet, no switching.
- A wallet may be authenticated by **up to 5** WebSocket connections (hard server limit; excess
  connections are auto-disconnected).

**Consequence for a 1000+ EOA fleet:** the public `fill` + `position_change` streams can be
multiplexed over **one** socket for the entire cohort (subscribe each subaccount, no auth).
`order_update` **cannot** — it needs **one authenticated socket per distinct wallet** (each with
its own in-tab signature on connect). ~1000 wallets ⇒ ~1000 authenticated sockets + ~1000
signatures per (re)connect cycle. That is a materially different cost/footprint from today's
single public stream.

**Recommended strategy:** do **not** blanket-authenticate the whole fleet. Authenticate
`order_update` only for a **focused working set** (e.g. the wallets currently in view / actively
being managed), and keep the bulk on the existing public `fill`/`position_change` + REST-poll
fallback. `order_update` adds the `placed` / `cancelled` reasons that `fill` alone doesn't give
(fills already arrive on the public `fill` stream), so the incremental value is mostly "my resting
orders changed state without a fill" — valuable for the viewed subset, low-value to stream for
1000 idle wallets.

---

## 7. Direct-from-browser vs relay; refresh cadence

- **Transport: direct from the browser.** The `/subscribe` WS already runs in-tab today for the
  public `fill` stream, so cross-origin WS is permitted (unlike the sequencer's REST, which 403s
  cross-origin and therefore needs the keyless relay). The authenticated `order_update` adds *only*
  an in-tab-signed `authenticate` frame before subscribing — **no relay, no server key, no server
  change.** The keyless REST relay (`app/api/nado/relay/[...path]`) is untouched.
- **Refresh cadence:** none needed mid-connection. `expiration` only bounds the *authenticate
  request's* validity window (≤100 s ahead); once the socket is authenticated it stays
  authenticated for the life of the connection. On the existing reconnect path (liveStream's
  exponential backoff), simply **re-sign + re-authenticate on each (re)open** before re-subscribing.
- **CORS/auth implications:** none beyond the above. No cookies, no bearer tokens, no server
  session — the only credential is the per-connection EIP-712 signature, made in-tab.

---

## 8. Source references

- Docs (authoritative): `https://docs.nado.xyz/developer-resources/api/subscriptions/authentication.md`
  (the `authenticate` frame + `StreamAuthentication` struct + expiration window + 5-connection
  limit + per-wallet scope) and `.../subscriptions/streams.md` (table: only `order_update` needs
  auth).
- SDK (installed `@nadohq/*` 0.58.0): `engine-client/dist/endpoints.js` (WS URLs);
  `engine-client/dist/types/serverSubscriptionTypes.d.ts` (`EngineServerOrderUpdateStreamParams`,
  methods list); `serverSubscriptionEventTypes.d.ts` (`order_update` event shape);
  `shared/dist/eip712/getNadoEIP712Domain.js` (domain). No `StreamAuthentication` builder exists in
  this version — hand-build it.
- Server self-description: the `/subscribe` socket's own parse errors enumerate the `authenticate`
  required fields and the full method list.

---

## 9. Implementation (shipped — scaling W5)

Browser-only change; server stays keyless. Delegate the signature to wative-core (do **not**
hand-roll crypto — only the typed-data *shape* is defined here).

1. **In-tab signer.** Add a small helper (alongside the existing in-tab order signer) that, given
   a wallet + subaccount hex, builds `expiration = String(Date.now() + ~60_000)` and returns a
   wative `signTypedData` over the §4 `StreamAuthentication` typed data (domain verifyingContract =
   the endpoint address the console already knows from config). Returns `{ tx:{sender,expiration},
   signature }`.
2. **`liveStream.ts`.** Extend `openLiveStream` so that, per authenticated wallet, on `ws.onopen`
   it first sends the `authenticate` frame, waits for `{result:null,id}`, and only then subscribes
   `order_update` (plus the public streams it already does). Keep public streams working with no
   auth. Handle an `error` on the auth frame by falling back to REST polling for that wallet (don't
   drop the socket). Re-authenticate on every reconnect (the backoff already re-runs `onopen`).
3. **Fleet policy (§6).** Gate `order_update` to a bounded working set of wallets, each on its own
   authenticated socket (respect the ≤5-conns-per-wallet limit; one is enough). Bulk cohort stays
   on the public `fill`/`position_change` streams + REST poll. Make the working-set size a config
   knob; measure socket/CPU cost before widening.
4. **Done:** the stale deferral comment in `liveStream.ts` was removed and `order_update` is wired into
   the same `onEvent` path the UI already consumes (the event handler recognizes `order_update`).
5. **Verify** with the project's live Flow against Ink testnet: place + cancel a resting order on a
   viewed wallet, assert `placed` then `cancelled` frames update order state without a poll; assert
   a foreign wallet's order_update is *not* received on that socket; assert reconnect re-auths.

### Fallback (if the wave is not pursued)

Keep the current model: poll the order rest/cancel state route, take fills from the public `fill`
stream. It is correct today; `order_update` is a latency/efficiency improvement for the *viewed*
subset, not a correctness fix. Given the per-wallet socket cost, "keep polling, tune the interval"
is a reasonable default for the idle bulk even after the wave ships.
