// =============================================================================
// @farm/loadgen · live-equity — the LIVE per-wallet equity source (A real-funds M0 guardrail).
// Reads the wallet's balances off the gateway (getBalances, backed by getSubaccountSummary) and
// sums its USDT0 collateral into an x18 signed-integer equity string for the coordinator's
// per-wallet maxLoss accounting (recordStats). Pure over an injected `forOwner` seam — the live
// gateway is handed in by the gated runner, and this is unit-tested offline with a fake gateway
// (no network, no funds). USDT0 is the quote collateral product (productId 0; see
// adapter-nado/execute.ts). At N=1 the hedged pair's net position ≈ 0, so collateral ≈ equity
// marked to market (the design's accepted approximation).
// =============================================================================
import type { NadoGateway } from "@farm/adapter-nado";
import type { Balance } from "@farm/adapter-api";
import type { EquitySource } from "./experiment-connector.js";

/** USDT0 is Nado's quote collateral product. */
export const USDT0_PRODUCT_ID = 0;

/** Parse a (possibly signed, possibly fractional) human-decimal amount into an x18 integer.
 *  getBalances returns `total` as a decimal string (x18ToDec of the raw summary amount); the
 *  coordinator's equityX18 is an x18 integer, so convert back. Truncates below 1e-18 (dust). */
export function decimalToX18(human: string): bigint {
  const s = String(human).trim();
  if (!/^-?\d*(?:\.\d*)?$/.test(s) || s === "" || s === "-" || s === "." || s === "-.") {
    throw new Error(`EQUITY_AMOUNT_UNPARSEABLE:${human}`);
  }
  const neg = s.startsWith("-");
  const [intPart = "0", fracPart = ""] = (neg ? s.slice(1) : s).split(".");
  const frac18 = fracPart.padEnd(18, "0").slice(0, 18);
  const raw = BigInt((intPart || "0") + frac18);
  return neg ? -raw : raw;
}

export interface LiveEquitySourceOpts {
  /** Subaccount label to read. Defaults to "default". */
  subaccount?: string;
  /** The collateral product to sum (USDT0 = 0). Defaults to USDT0_PRODUCT_ID. */
  collateralProductId?: number;
}

/**
 * Build an EquitySource over a per-owner gateway view. A successful read sums the wallet's USDT0
 * collateral balances to an x18 integer string (0 when the wallet holds no USDT0 — a real,
 * reportable zero, not "unknown"). A read FAILURE propagates (the coordinator treats an
 * unreadable account as EXPERIMENT_ACCOUNT_UNKNOWN — unknown is never flat); it never swallows an
 * error into a fabricated equity.
 */
export function createLiveEquitySource(
  forOwner: (owner: string) => Pick<NadoGateway, "getBalances">,
  opts: LiveEquitySourceOpts = {},
): EquitySource {
  const subaccount = opts.subaccount ?? "default";
  const collateral = String(opts.collateralProductId ?? USDT0_PRODUCT_ID);
  return async (owner: string): Promise<string | null> => {
    const balances: Balance[] = await forOwner(owner).getBalances(subaccount);
    let sumX18 = 0n;
    for (const b of balances) if (String(b.asset) === collateral) sumX18 += decimalToX18(String(b.total));
    return String(sumX18);
  };
}
