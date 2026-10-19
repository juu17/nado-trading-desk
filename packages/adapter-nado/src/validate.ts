// =============================================================================
// @farm/adapter-nado · order validation (M10) — round a PlaceOrderInput to the
// market's tick (price) and step (size), and check the min-notional. Pure +
// integer-exact (no float drift): all values are scaled to 1e18 and rounded with
// bigint math. Input hygiene only — no strategy, no EV, no price opinion.
// =============================================================================
import { parseUnits, formatUnits } from "viem";
import type { PlaceOrderInput, Market, Decimal } from "@farm/adapter-api";

const P = 18;

function roundToIncrement(value: string, increment: string, mode: "nearest" | "down"): string {
  const inc = parseUnits(increment, P);
  if (inc === 0n) return value;
  const v = parseUnits(value, P);
  const q = mode === "down" ? v / inc : (v + inc / 2n) / inc;
  return formatUnits(q * inc, P);
}

export type OrderViolationCode = "TICK_ROUNDED" | "STEP_ROUNDED" | "MIN_NOTIONAL" | "NON_POSITIVE_SIZE";
export interface OrderViolation { code: OrderViolationCode; message: string; severity: "info" | "error" }

export interface ValidatedOrder {
  input: PlaceOrderInput;
  normalized: PlaceOrderInput;      // rounded to tick/step
  violations: OrderViolation[];
  ok: boolean;                      // false if any error-severity violation
}

/** Validate + round an order against its market. Price/notional checks are skipped
 *  for market orders (no limit price). */
export function validateOrder(input: PlaceOrderInput, market: Market): ValidatedOrder {
  const violations: OrderViolation[] = [];
  const isLimit = input.kind !== "market" && input.price !== undefined;

  // size → step (round down, never up — don't oversize)
  let size = input.size as string;
  if (market.stepSize) {
    const rounded = roundToIncrement(size, market.stepSize as string, "down");
    if (rounded !== size) violations.push({ code: "STEP_ROUNDED", message: `size ${size} rounded down to step ${market.stepSize} → ${rounded}`, severity: "info" });
    size = rounded;
  }
  if (parseUnits(size, P) <= 0n) {
    violations.push({ code: "NON_POSITIVE_SIZE", message: `size ${size} is not positive after step rounding`, severity: "error" });
  }

  // price → tick (nearest)
  let price = input.price as string | undefined;
  if (isLimit && price !== undefined && market.tickSize) {
    const rounded = roundToIncrement(price, market.tickSize as string, "nearest");
    if (rounded !== price) violations.push({ code: "TICK_ROUNDED", message: `price ${price} rounded to tick ${market.tickSize} → ${rounded}`, severity: "info" });
    price = rounded;
  }

  // min-notional = price * size >= market.minNotional (limit only)
  if (isLimit && price !== undefined && market.minNotional) {
    const notional = (parseUnits(price, P) * parseUnits(size, P)) / 10n ** BigInt(P);
    const min = parseUnits(market.minNotional as string, P);
    if (notional < min) {
      violations.push({ code: "MIN_NOTIONAL", message: `notional ${formatUnits(notional, P)} below min ${market.minNotional}`, severity: "error" });
    }
  }

  const normalized: PlaceOrderInput = { ...input, size: size as Decimal, price: isLimit ? (price as Decimal) : input.price };
  return { input, normalized, violations, ok: !violations.some((v) => v.severity === "error") };
}
