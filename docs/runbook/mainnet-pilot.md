# Mainnet pilot runbook (Ink mainnet, chainId 57073)

> ⚠️ **Real capital.** This moves real USDT0 and real ETH on Ink mainnet. The operator triggers
> every live submit (deposit / place / cancel / withdraw / any taker fill). The assistant sets up
> the config and verifies the setup; it does not place real-money orders.
>
> Do this **only after** the full testnet matrix is proven. Start with **one wallet, minimum size.**

## 0. What is already settled (so you know what you're trusting)

- **Order signing is correct by construction on mainnet.** The order EIP-712 `verifyingContract` is a
  chain-agnostic sentinel `address(uint160(productId))`; the only chain-specific order-domain field is
  `chainId`, which the Network toggle flips. The deposit/cancel/withdraw domain uses the mainnet **Endpoint**
  (`0x05ec92D78ED421f3D3Ada77FFdE167106565974E`), which flows automatically from the SDK's mainnet
  deployment. See `reference_nado_order_domain` in project memory.
- **Order sizing is correct** (min-notional vs min-size fix): `clampOrderSize` floors to
  one size increment and bumps up to clear the venue **min notional of 100 USDT0**; the per-order spend cap
  compares the true `price × size` notional.
- **Half-flip guard:** the selected network is a cookie read by both the client and the server API routes.
  `liveFor()` cross-checks the client's selected `chainId` against the server-reported `chainId` and refuses
  to sign on a mismatch, so a switch that didn't fully apply fails loudly instead of signing wrong.

## 1. Inputs (both verified on-chain 2026-10-18 — re-verify before use)

| Input | Value | How it was verified |
|---|---|---|
| Ink-mainnet RPC (CORS-open) | `https://rpc-gel.inkonchain.com` | returns `access-control-allow-origin: *`, `eth_chainId` = `0xdef1` (57073) |
| Mainnet USDT0 collateral (6-dec) | `0x0200C29006150606B650577BBE7B6248F58470c1` | read from mainnet spot engine `getToken(0)` → decimals 6, symbol USD₮0 |
| Mainnet Endpoint (deposit contract) | `0x05ec92D78ED421f3D3Ada77FFdE167106565974E` | `NADO_DEPLOYMENTS[inkMainnet].endpoint` |

Re-verify the RPC CORS header and `getToken(0)` before the pilot — a wrong collateral address means lost funds.
Cross-check the USDT0 address against Nado's official mainnet docs as a second source.

## 2. Selecting mainnet (a UI toggle — no env, no rebuild)

Both networks are **pre-set** in `apps/console/app/lib/chainEnv.ts` (chainId, RPC, USDT0, caps). Flip with
the sidebar **`Testnet | Mainnet`** segment control: tapping **Mainnet** pops a "real funds" confirm, then
the Mainnet pole turns solid red and the header badge + sidebar workspace label read `mainnet`. The
selection is a cookie read by the client AND the server routes; the switch is live (the vault stays
unlocked). The only server requirement is `NADO_LIVE=1`. Full procedure:
[`switching-testnet-mainnet.md`](switching-testnet-mainnet.md).

- Mainnet **spend caps are baked tight** by default (order 150, deposit 200, refuel 0.005 ETH, cohort 1000
  USDT0). They stay overridable via the `NEXT_PUBLIC_NADO_MAX_*` build-time env if you need different limits.
- The mainnet RPC + USDT0 (§1) are already baked in — nothing to set.

## 3. Pre-flight (no orders yet)

1. **Fund the pilot wallet (real):** bridge ~150–200 USDT0 to the one pilot EOA on Ink mainnet, and send it a
   little ETH for gas (or refuel from the treasury, capped at 0.005 ETH). Mainnet USDT0 is **bridged, not minted**
   — the mint path stays testnet-gated. See `funding-onramp.md`.
2. **Run** the console with `NADO_LIVE=1`, then flip the Network toggle to **Mainnet** and confirm. The
   Mainnet pole must show solid red and the header/sidebar must read `mainnet`.
3. **Chain-consistency:** open the live drawer for the pilot wallet — the client + server resolve the chain from
   the same cookie, so `liveFor()` only throws "chain mismatch" if a switch didn't fully apply. No error = aligned.
4. **Sequencer reachability:** confirm the app's market list loads (the server queries `api.prod.nado.xyz`
   via the SDK when `CHAIN_ID=57073`). A mainnet preflight can mirror `packages/adapter-nado/scripts/testnet-preflight.mjs` with the
   mainnet chain id.

## 4. One-wallet min-notional pilot (operator triggers each live submit)

Do these on a **single** wallet, in order. Nothing fans out to the cohort until this round-trip is clean.

1. **Deposit** ~150 USDT0 collateral (approve + `depositCollateral`). Confirm it mines and the quote balance updates.
2. **Place ONE maker order at the minimum:** pick a market (e.g. BTC-PERP), a price **inside the oracle 80–120%
   band and clearly away from crossing** (above the ask for a sell / below the bid for a buy, so it *rests*,
   does not fill → no position opened, no funds moved beyond the resting margin hold). Enter a tiny size and let
   `clampOrderSize` bump it to the ~100 USDT0 min notional, or enter the size directly. Verify the Activity log
   shows `role=maker · open` and it appears in Open orders.
3. **Cancel** that order. A resting-then-cancelled order confirms the place/cancel path with no fill.
4. **(Optional, deliberate) one taker fill:** a crossing IOC at the minimum size to prove the taker→fill→position
   path (the one path untested anywhere). This **opens a real position**. If you do it, immediately **close**
   (flatten) it. Skip this to keep the pilot flat.
5. **Withdraw** the collateral back out. A clean deposit → place → cancel → withdraw round-trip is the pilot's
   success criterion.

## 5. Known limitations to accept before going live

These are declared-but-not-wired — do **not** build a mainnet strategy on them:

- `fok` **silently downgrades** to a plain resting limit (no fill-or-kill).
- `market` kind is **emulated** (a crossing IOC), not a native market order.
- **Isolated margin is ignored** — every position is cross-margined.
- **Triggers / stop-loss / STP** are ignored; **builder-fee** is not wired.
- Reject-code handling beyond `2013` (e.g. `2007` oracle band) is unverified.
- 1000-wallet **scale** has never been run live. Keep the pilot to one wallet.
- The sizing fix has only soaked on testnet.

## 6. Rollback

Tap **Testnet** in the network toggle — it flips the `nado-chain-id` cookie instantly, with no rebuild or
restart (the app defaults to Ink testnet when the cookie is unset). Clear any `NEXT_PUBLIC_NADO_MAX_*` cap
overrides set for the pilot. The full test suite is green on testnet.

## 7. Boundary

The assistant builds this config, verifies the setup (guard loads, chain-consistency, a resting-order dry check on
testnet), and reports. **The operator triggers every real-money submit** on mainnet — executing live trades is the
operator's action, not the assistant's.
