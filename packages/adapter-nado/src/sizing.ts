// =============================================================================
// Nado market-sizing unit conventions (verified LIVE 2026-10-18 against
// api.{test,prod}.nado.xyz getSymbols). These were the source of a real bug, so the
// interpretation is pinned here with tests.
//
// getSymbols returns, per market:
//   • priceIncrement : HUMAN price tick            (e.g. "1" for BTC-PERP, "0.01" for equities)
//   • sizeIncrement  : X18 base-asset size step    (e.g. 50000000000000 = 0.00005 BTC)
//   • minSize        : ⚠ MISNAMED — the minimum ORDER NOTIONAL in X18 **USDT0**, and it is
//                      UNIFORM across every market (100000000000000000000 = 100 USDT0 for
//                      BTC-PERP, wNVDAx, wAAPLx, wQQQx …). A per-asset min *size* could never
//                      be identical for BTC and a stock, which is the tell. Treating this field
//                      as a base-asset min size floors every order to ~100 base units
//                      (~10,000× too large) — the bug this module exists to prevent.
//
// So: the smallest tradeable base size is ONE sizeIncrement, and there is a separate min
// NOTIONAL (USDT0) the order must clear. clampOrderSize honours both.
// =============================================================================
import { formatUnits, parseUnits } from "viem";

export interface NadoMarketSizing {
  tickSize: string;     // HUMAN price tick
  stepSize: string;     // HUMAN base-asset size step (one sizeIncrement)
  minSize: string;      // HUMAN min base size = one step (the smallest tradeable size)
  minNotional: string;  // HUMAN min order notional, in USDT0
}

/** Map a Nado getSymbols entry's raw increments to human market sizing with the CORRECT unit
 *  interpretation. `sizeIncrementX18` / `minSizeX18` are the X18 integer forms (the caller has
 *  already taken BigNumber → integer bigint); `priceIncrementHuman` is the human tick string. */
export function nadoMarketSizing(
  priceIncrementHuman: string,
  sizeIncrementX18: bigint,
  minSizeX18: bigint,
): NadoMarketSizing {
  const stepSize = formatUnits(sizeIncrementX18, 18);
  return {
    tickSize: priceIncrementHuman,
    stepSize,
    minSize: stepSize,                        // smallest tradeable base size = one size increment
    minNotional: formatUnits(minSizeX18, 18), // the field Nado calls "minSize" is a USDT0 notional floor
  };
}

/** Align a human decimal value DOWN to a human increment. */
function alignDown(valHuman: string, incHuman: string): string {
  const inc = parseUnits(incHuman, 18);
  if (inc <= 0n) return valHuman;
  const v = parseUnits(valHuman, 18);
  return formatUnits((v / inc) * inc, 18);
}

/** Align a human decimal value UP to a human increment. */
function alignUp(valHuman: string, incHuman: string): string {
  const inc = parseUnits(incHuman, 18);
  if (inc <= 0n) return valHuman;
  const v = parseUnits(valHuman, 18);
  const up = ((v + inc - 1n) / inc) * inc;
  return formatUnits(up, 18);
}

export interface ClampOrderSizeOpts {
  stepSize: string;               // HUMAN size step
  minSize: string;                // HUMAN min base size (one step)
  price?: string | number;        // HUMAN resolved price (enables the min-notional bump)
  minNotional?: string;           // HUMAN min order notional, USDT0
}

/** Clamp an operator's order size to a VALID, placeable base size:
 *   1. at least the min base size (one step), aligned DOWN to the step; then
 *   2. if a price and a min notional are known, bumped UP (step-aligned) so the order clears
 *      the venue's min NOTIONAL.
 *  It never inflates a size that already clears both minimums (the bug was a ~10,000× inflation
 *  from treating the min-notional field as a base min size). With no price/minNotional (e.g. the
 *  offline mock path) it degrades to the original floor-and-align behaviour. */
export function clampOrderSize(uiSize: string | number | undefined, opts: ClampOrderSizeOpts): string {
  const minBase = Number(opts.minSize);
  const chosen = Number(uiSize ?? 0) > minBase ? String(uiSize) : opts.minSize;
  let aligned = alignDown(chosen, opts.stepSize);
  if (Number(aligned) < minBase) aligned = opts.minSize;

  const price = Number(opts.price ?? 0);
  const minNotional = Number(opts.minNotional ?? 0);
  if (price > 0 && minNotional > 0 && Number(aligned) * price < minNotional) {
    // Bump UP to the smallest step-aligned size whose notional clears the minimum.
    aligned = alignUp((minNotional / price).toFixed(18), opts.stepSize);
  }
  return aligned;
}
