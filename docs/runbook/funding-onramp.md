# Funding on-ramp runbook — getting gas + USDT0 onto the cohort

How each cohort wallet gets the native **gas (ETH)** and **quote collateral (USDT0)** it needs
before it can trade. Orders themselves are gasless (off-chain EIP-712); only the funding
lifecycle — gas top-up, USDT0 acquisition, and `depositCollateral` — touches the chain.

The on-ramp is **environment-split**: on **testnet** USDT0 is *minted* (an open faucet token);
on **mainnet** USDT0 must be *bridged* onto Ink, which is an **operational** step run outside
the tab (see "Mainnet"). This split is the whole of open question **M2**.

## Testnet on-ramp (in-tab, shipped)

All three steps sign in the operator's tab (sealed in-tab keys) and broadcast through a keyless
client — no server key. Reference end-to-end script: `packages/adapter-nado/scripts/fund-cohort.mjs`
(the CLI the in-app paths productize).

1. **Gas** — the treasury (`live:0`, externally funded) fans out native ETH to each wallet.
   - In-app: the per-wallet **Refuel gas** action (`refuelGasLive`, Wave 3b).
   - A wallet needs gas *before* it can `approve`/`deposit` — an `unfunded` wallet is also gasless.
2. **USDT0** — the treasury mints the openly-mintable testnet USDT0 to each wallet.
   - In-app: the per-wallet **Mint** action (`mintUsdt0Live`, Wave 4a). 6-decimal amount.
   - Testnet-only and hard-gated to the Ink testnet chain id — the token is a faucet; mainnet
     USDT0 has no caller-mint (see below).
3. **Deposit** — each wallet `approve(max)` + `depositCollateral` into its own `default` subaccount.
   - In-app: the per-wallet **Deposit** action (`depositLive`). Collateral is credited once the
     sequencer indexes it (readiness flips `funded`/`ready`).

Treasury-sourced steps (gas, mint) serialize on the treasury's single nonce; deposits are
per-wallet and independent. **Idempotency differs by surface:** the `fund-cohort.mjs` CLI (and
the future bulk runner, Wave 4b) skip already-funded wallets via `balanceOf`/`allowance` checks;
the **per-wallet in-app actions** (Refuel / Mint / Deposit) re-run **unconditionally** on each
click (no balance-skip), so the operator decides. `depositCollateral` is **not** idempotent, so a
bulk re-run must target only wallets that are still `unfunded`.

## Mainnet on-ramp (operational — NOT in-tab)

On mainnet USDT0 is a real bridged asset; there is no faucet mint, so steps 1–2 above do not
apply. Getting USDT0 onto Ink for the cohort is an **operator-run, out-of-tab** procedure, gated
on mainnet enablement + real capital (Phase 6) and on the on-ramp **topology** decision
(Q53 / Q56 / M14) — a naive automated one-treasury→many bridge would bake in a public, linkable
funding graph, which that decision exists to avoid. It is deliberately **not** built as an in-tab
client feature.

- **Preferred:** a CEX that withdraws USDT0 **natively to Ink**, drawn down **staggered per
  wallet** (vary timing/amounts) so the funding graph is not a single fan-out.
- **Fallback:** a **canonical bridge**, wrapped as a **monitored, idempotent per-wallet step**
  with explicit stuck-bridge handling (retry/resume without double-sending).
- Native gas on mainnet is likewise acquired operationally (CEX native-ETH withdrawal to Ink),
  not via an in-tab treasury faucet.

Until mainnet gating lands, the readiness `unfunded` state plus this runbook are the honest
record of the gap — the UI surfaces no in-tab "bridge" control, because none exists.
