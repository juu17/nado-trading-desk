// =============================================================================
// @farm/ui · readiness — a pure, protocol-neutral DISPLAY computation of a wallet's
// readiness from REPORTED values (collateral + native gas). This is view-model derivation,
// not core strategy/compute: [#13] blesses display consumers deriving transiently from
// reported values, and @farm/ui is the view-model layer (alongside accounting/fleet/filter),
// never core. The vocabulary matches the adapter's ordered manifest.account.readinessStates.
// =============================================================================
import type { Readiness } from "./model.js";

export interface ReadinessInputs {
  /** Indexed QUOTE collateral (e.g. USDT0, productId 0). > 0 means the subaccount exists + is funded
   *  (the venue creates the subaccount on first deposit). */
  quote: number;
  /** Native (ETH) gas balance. */
  native: number;
  /** Native gas needed to run the on-chain funding bootstrap (approve + deposit). Injected, not baked. */
  gasFloor: number;
}

/** Derive readiness (DISPLAY-only) from reported collateral + gas:
 *  - `unfunded`: no credited quote collateral — nothing deposited yet.
 *  - `funded`:   has collateral but gas < floor — can TRADE (orders are gasless) but lacks gas to run
 *                the on-chain funding lifecycle (approve + deposit/refuel) — the gas-refuel target set.
 *  - `ready`:    has collateral AND gas >= floor — terminal: trade + fund the full lifecycle. */
export function computeReadiness({ quote, native, gasFloor }: ReadinessInputs): Readiness {
  if (!(quote > 0)) return "unfunded";
  return native >= gasFloor ? "ready" : "funded";
}
