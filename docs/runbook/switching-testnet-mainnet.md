# Switching between testnet and mainnet (placing orders with real funds)

How an operator flips the Nado Trading Desk console between **Ink testnet** (play money, faucet) and **Ink
mainnet** (real USDT0, real losses), and then places a live order. Switching is a **UI toggle** — no
env vars, no rebuild. Read this before you flip to mainnet: selecting mainnet moves real funds.

> The mainnet contract addresses + the full pre-flight checklist live in
> [`mainnet-pilot.md`](mainnet-pilot.md). This doc is the **switching procedure**.

---

## 1. The toggle

Both networks are **pre-set** in [`apps/console/app/lib/chainEnv.ts`](../../apps/console/app/lib/chainEnv.ts)
— `chainId`, a CORS-open RPC, the USDT0 collateral token, and per-network spend caps. The selected
network is a **2-pole `Testnet | Mainnet` segment control** in the sidebar.

- **Testnet** is the default and flips **instantly**.
- **Mainnet** flips **behind a confirm** ("⚠ Switch to MAINNET — real funds") because it moves real money.
- The switch is **live**: no reload and **your vault stays unlocked** (the keys are chain-agnostic; only
  the chain config changes). On mainnet the **Mainnet pole of the toggle turns solid red** and the header
  badge + sidebar workspace label read **mainnet**.

Under the hood the selection is a cookie (`nado-chain-id`) read by **both** the browser and the Node API
routes, so the client and server always agree on the chain. The live path still cross-checks the
client's selected chainId against the server's per request and **refuses to sign on a mismatch** (so a
switch that didn't fully apply fails safe instead of signing on the wrong chain).

## 2. Spend caps are per-network

Caps are baked per network (a breach is always a **loud reject**, never a silent clamp), **tight on
mainnet** by default:

| Cap | Testnet default | Mainnet default | Env override (build-time) |
|---|---|---|---|
| per-order notional (USDT0) | 1,000,000 | **150** | `NEXT_PUBLIC_NADO_MAX_ORDER_NOTIONAL_USDT0` |
| per-deposit (USDT0) | 100,000 | **200** | `NEXT_PUBLIC_NADO_MAX_DEPOSIT_USDT0` |
| per-refuel (ETH) | 1 | **0.005** | `NEXT_PUBLIC_NADO_MAX_REFUEL_ETH` |
| cohort-funding ceiling (USDT0) | 1,000,000 | **1,000** | `NEXT_PUBLIC_NADO_MAX_COHORT_USDT0` |

The env vars still override the per-network default at build time if you need different limits; most
operators never touch them.

---

## 3. Procedure — flip to mainnet and place a real order

1. **Start the console** with the live path on: `NADO_LIVE=1` on the server (do **not** set
   `NADO_DEV_SEED=1` for mainnet — that's the testnet faucet-seed bridge). No chain env is needed.
2. **Enter the app** and create or unlock your vault. The password encrypts your keys in-browser and
   **has no recovery** — save it.
3. **Tap `Mainnet`** on the Network toggle → **confirm** the "real funds" dialog. The **Mainnet pole turns
   solid red** and the sidebar reads *Fleet console · mainnet* (the header badge reads *LIVE mainnet*). If
   the Mainnet pole isn't red, stop — you're still on testnet.
4. **Create a PK account and import your funded key(s)** on `/accounts` — the private key(s) of wallet(s)
   already funded on Ink mainnet (paste, or scan a QR with the camera to keep the key off the clipboard).
   Keys sign **in your browser tab only**; the server holds none.
5. **Fund the subaccount.** Mainnet USDT0 is **bridged, not minted** (no faucet). Send USDT0 to the
   wallet's Nado deposit address (the DDA + QR in the wallet drawer), or use the drawer's on-chain
   **Deposit** (needs native ETH for gas; **Refuel gas** moves ETH from the treasury wallet `live:0`).
6. **Verify balances** in the wallet drawer (the Balances list) before trading.
7. **Place a FIRST SMALL order** from the wallet drawer. Order signing is correct-by-construction on
   mainnet (the per-product `verifyingContract` is a chain-agnostic sentinel; only `chainId` differs),
   but **start tiny and watch it settle** before any bulk run.

**To switch back to testnet:** tap `Testnet` — instant, no confirm; the Mainnet pole's red clears and the
header/sidebar return to reading *testnet*.

## 4. Safety invariants (that hold on mainnet)

- **Confirm before mainnet** — flipping to mainnet always requires the confirm dialog.
- **Loud-reject caps** — every money op is bounded by the per-network caps; a breach throws.
- **No faucet mint on mainnet** — the mint path is testnet-only; USDT0 must be bridged in.
- **Half-flip guard** — the client's selected chainId is cross-checked against the server's per request;
  a mismatch refuses rather than mis-signing.
- **Keys stay in-tab** — the server holds no key; orders / funding / withdraws all sign in the browser.
- **No password recovery** — a lost vault password means resetting the local vault (Danger-zone button
  on the Unlock screen) and re-importing your PK keys.
