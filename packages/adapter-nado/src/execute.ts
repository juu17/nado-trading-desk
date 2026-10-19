// =============================================================================
// @farm/adapter-nado · EIP-712 execute builders.
//
// Builds the Nado execute typed-data from the normalized seam inputs, using the
// Nado SDK's own value builder (`getNadoEIP712Values`) so the signed message is
// byte-identical to what the sequencer reconstructs from the submitted payload
// (`buildPlaceOrderPayloadSync` re-runs the SAME builder) — proven byte-equal to
// wative's strict signTypedData + ecrecover in Phase 1a.
//
// UNIT CONTRACT (verified live + against the SDK, 2026-10-16):
//   • order.price   — a HUMAN decimal string; the SDK scales it ×1e18 → priceX18.
//   • order.amount  — an X18 SIGNED integer string (+buy / −sell), passed through.
//   • order.appendix— packOrderAppendix(...) (v1); appendix 0 is rejected 2095.
// The adapter owns the size→X18 scaling; price stays human for the SDK to scale.
//
// Signing is NOT done here — the plan runner signs the returned typedData via the
// seam WalletSigner. The `order`/`cancel` objects are carried on the result so the
// live gateway can hand them to the SDK's sync payload builder unchanged.
// =============================================================================
import {
  getNadoEIP712Domain,
  getNadoEIP712Types,
  getNadoEIP712PrimaryType,
  getNadoEIP712Values,
  getOrderNonce,
  getOrderVerifyingAddress,
  packOrderAppendix,
} from "@nadohq/client";
import { parseUnits } from "viem";
import type { Eip712TypedData, PlaceOrderInput, CancelInput } from "@farm/adapter-api";

const X18 = 18;
const ZERO_ENDPOINT = "0x0000000000000000000000000000000000000000";
const DEFAULT_ORDER_TTL_SECS = 7 * 24 * 60 * 60; // resting maker default (overridable)

export interface NadoSubaccount {
  ownerAddress: string;     // the EVM owner (0x…)
  subaccountName?: string;  // default "default"
}

export interface PlaceOrderContext extends NadoSubaccount {
  chainId: number;
  productId: number;        // Nado product id (verifyingContract derives from it)
  nonce?: bigint;           // defaults to a fresh order nonce
  expiration?: bigint;      // unix seconds; defaults to now + DEFAULT_ORDER_TTL_SECS
}

export interface CancelContext extends NadoSubaccount {
  chainId: number;
  verifyingContract?: string; // the Nado endpoint address (per-deploy); the cancel
                              // domain uses it, so LIVE cancels MUST set it.
  nonce?: bigint;
}

export interface WithdrawContext extends NadoSubaccount {
  chainId: number;
  endpoint: string;    // the Nado Endpoint address — the withdraw domain's verifyingContract
  productId: number;   // the collateral product (0 = USDT0 quote)
  nonce: string;       // the sequential TX nonce (from the sequencer), NOT a recvTime nonce
}

/** The order object the SDK value builder + sync payload builder both consume. All
 *  fields are the SDK's stringy runtime contract (verified empirically 2026-10-16):
 *  price is a HUMAN decimal; amount an X18 signed integer; the rest decimal strings. */
export interface NadoOrderParams {
  subaccountOwner: string;
  subaccountName: string;
  price: string;      // HUMAN decimal
  amount: string;     // X18 signed integer
  expiration: string;
  nonce: string;
  appendix: string;
}

export interface NadoCancelParams {
  subaccountOwner: string;
  subaccountName: string;
  productIds: number[];
  digests: string[];
  nonce: string;
}

/** The withdraw object the SDK value builder + async payload builder both consume.
 *  `amount` is the collateral's NATIVE-unit integer string (USDT0 = 6-dec), passed
 *  through verbatim — withdraw amounts are NOT x18-scaled (unlike order size). */
export interface NadoWithdrawParams {
  subaccountOwner: string;
  subaccountName: string;
  productId: number;
  amount: string;
  nonce: string;
}

export interface BuiltOrder {
  typedData: Eip712TypedData;
  order: NadoOrderParams;   // handed verbatim to buildPlaceOrderPayloadSync (live)
  sender: string;           // bytes32 subaccount (0x-hex)
  priceX18: bigint;
  amount: bigint;           // signed (buy > 0, sell < 0)
  nonce: bigint;
  expiration: bigint;
  productId: number;
}

export interface BuiltCancel {
  typedData: Eip712TypedData;
  cancel: NadoCancelParams;  // handed verbatim to buildCancelOrdersPayloadSync (live)
  sender: string;
  productIds: number[];
  digests: string[];
  nonce: bigint;
}

export interface BuiltWithdraw {
  typedData: Eip712TypedData;
  withdraw: NadoWithdrawParams; // handed verbatim to buildWithdrawCollateralPayload (live)
  sender: string;              // bytes32 subaccount (0x-hex)
}

function execTypeFor(input: PlaceOrderInput): "post_only" | "default" | "ioc" {
  // post-only limit → resting maker (appendix 1537). ioc / market → a taker that
  // fills what the book has and cancels the rest (appendix 513). Else → default (1).
  if (input.postOnly) return "post_only";
  if (input.tif === "ioc" || input.kind === "market") return "ioc";
  return "default";
}

/** Coerce the SDK value builder's numeric fields to bigint for viem signing + tests. */
function toSignableMessage(raw: Record<string, unknown>): Record<string, unknown> {
  const big = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v)));
  return {
    ...raw,
    priceX18: big(raw["priceX18"]),
    amount: big(raw["amount"]),
    expiration: big(raw["expiration"]),
    nonce: big(raw["nonce"]),
    appendix: big(raw["appendix"]),
  };
}

/** Build the `place_order` typed-data + the raw order the live gateway needs. */
export function buildPlaceOrderTypedData(input: PlaceOrderInput, ctx: PlaceOrderContext): BuiltOrder {
  const nonce = ctx.nonce ?? BigInt(getOrderNonce());
  const expiration = ctx.expiration ?? BigInt(Math.floor(Date.now() / 1000) + DEFAULT_ORDER_TTL_SECS);
  // adapter owns the size→X18 scaling; price stays human for the SDK to scale.
  const sizeAbs = parseUnits(input.size as string, X18);
  const amount = input.side === "buy" ? sizeAbs : -sizeAbs;
  const order: NadoOrderParams = {
    subaccountOwner: ctx.ownerAddress,
    subaccountName: ctx.subaccountName ?? "default",
    price: input.price != null ? String(input.price) : "0",
    amount: amount.toString(),
    expiration: expiration.toString(),
    nonce: nonce.toString(),
    // reduceOnly sets the appendix's reduce-only bit (2048): the venue caps the fill at the
    // current position and never flips it — so a close IOC can't overshoot on a thin book.
    // reduceOnly:false is a no-op (same appendix as before), so this is backward-compatible.
    appendix: packOrderAppendix({ orderExecutionType: execTypeFor(input), reduceOnly: input.reduceOnly ?? false }).toString(),
  };
  const message = toSignableMessage(getNadoEIP712Values("place_order", order as never) as Record<string, unknown>);
  const typedData: Eip712TypedData = {
    domain: getNadoEIP712Domain(getOrderVerifyingAddress(ctx.productId), ctx.chainId),
    types: getNadoEIP712Types("place_order"),
    primaryType: getNadoEIP712PrimaryType("place_order"),
    message,
  };
  return {
    typedData, order,
    sender: String(message["sender"]),
    priceX18: message["priceX18"] as bigint,
    amount: message["amount"] as bigint,
    nonce, expiration, productId: ctx.productId,
  };
}

/** Build the `cancel_orders` typed-data from the normalized cancel input. */
export function buildCancelTypedData(input: CancelInput, ctx: CancelContext, productIds: number[]): BuiltCancel {
  const nonce = ctx.nonce ?? BigInt(getOrderNonce());
  const digests = input.venueIds ?? [];
  const cancel: NadoCancelParams = {
    subaccountOwner: ctx.ownerAddress,
    subaccountName: ctx.subaccountName ?? "default",
    productIds, digests, nonce: nonce.toString(),
  };
  const message = getNadoEIP712Values("cancel_orders", cancel as never) as Record<string, unknown>;
  const signable = { ...message, nonce: typeof message["nonce"] === "bigint" ? message["nonce"] : BigInt(String(message["nonce"])) };
  const typedData: Eip712TypedData = {
    domain: getNadoEIP712Domain(ctx.verifyingContract ?? ZERO_ENDPOINT, ctx.chainId),
    types: getNadoEIP712Types("cancel_orders"),
    primaryType: getNadoEIP712PrimaryType("cancel_orders"),
    message: signable,
  };
  return { typedData, cancel, sender: String(message["sender"]), productIds, digests, nonce };
}

/** Build the `withdraw_collateral` typed-data from a native-unit amount + a sequential
 *  TX nonce. The signed message is byte-identical to what the sequencer reconstructs,
 *  because `buildWithdrawCollateralPayload` re-runs the SAME `getNadoEIP712Values` on the
 *  returned `withdraw` object — the client signs it IN-TAB and injects the signature, so
 *  no walletClient is needed server-side. (withdraw_collateral type: sender bytes32,
 *  productId uint32, amount uint128, nonce uint64 — verified against the SDK 2026-10-16.) */
export function buildWithdrawTypedData(amount: string, ctx: WithdrawContext): BuiltWithdraw {
  const withdraw: NadoWithdrawParams = {
    subaccountOwner: ctx.ownerAddress,
    subaccountName: ctx.subaccountName ?? "default",
    productId: ctx.productId,
    amount,            // native-unit integer (USDT0 6-dec); NOT x18-scaled
    nonce: ctx.nonce,
  };
  const raw = getNadoEIP712Values("withdraw_collateral", withdraw as never) as Record<string, unknown>;
  // Coerce the uint fields to bigint for strict EIP-712 signing (sender stays bytes32
  // hex, productId stays a uint32 number). Mirrors the place_order message coercion.
  const big = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v)));
  const message: Record<string, unknown> = { ...raw, amount: big(raw["amount"]), nonce: big(raw["nonce"]) };
  const typedData: Eip712TypedData = {
    domain: getNadoEIP712Domain(ctx.endpoint, ctx.chainId),
    types: getNadoEIP712Types("withdraw_collateral"),
    primaryType: getNadoEIP712PrimaryType("withdraw_collateral"),
    message,
  };
  return { typedData, withdraw, sender: String(raw["sender"]) };
}

// ---- StreamAuthentication (order_update WS auth) -------------------------------------------
// The sequencer gates the real-time `order_update` WS stream behind a signed `authenticate`
// frame. @nadohq 0.58.0 ships NO StreamAuthentication builder, so hand-build the typed data: it
// is a standard Nado-domain EIP-712 over (bytes32 sender, uint64 expiration), so wative signs it
// IN-TAB (byte-equal, Phase 1a) and the server stays keyless. NB `expiration` here is UNIX
// MILLISECONDS (order expiration elsewhere is seconds); it must be in the future and <=100s ahead.
export interface StreamAuthContext { chainId: number; endpoint: string }
export interface BuiltStreamAuth { typedData: Eip712TypedData; sender: string; expiration: string }
export function buildStreamAuthTypedData(sender: string, expirationMs: string, ctx: StreamAuthContext): BuiltStreamAuth {
  const typedData: Eip712TypedData = {
    domain: getNadoEIP712Domain(ctx.endpoint, ctx.chainId),
    types: { StreamAuthentication: [{ name: "sender", type: "bytes32" }, { name: "expiration", type: "uint64" }] },
    primaryType: "StreamAuthentication",
    message: { sender, expiration: BigInt(expirationMs) }, // bigint for strict uint64 signing
  };
  return { typedData, sender, expiration: expirationMs };
}
