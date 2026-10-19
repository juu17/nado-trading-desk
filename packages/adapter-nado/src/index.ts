// @farm/adapter-nado — the first ProtocolAdapter: Nado CLOB/perps on Ink.
// EIP-712 executes built via @nadohq/client (proven byte-equal to wative's strict
// signTypedData in Phase 1a) and signed through the seam WalletSigner; on-chain
// funding (approve + depositCollateral) will ride chain-level ExecutionPlan steps.
export { NadoAdapter } from "./adapter.js";
export type { NadoAdapterOpts } from "./adapter.js";
export { NADO_MANIFEST } from "./manifest.js";
export {
  buildPlaceOrderTypedData,
  buildCancelTypedData,
  buildWithdrawTypedData,
  buildStreamAuthTypedData,
} from "./execute.js";
export type {
  NadoSubaccount,
  PlaceOrderContext,
  CancelContext,
  WithdrawContext,
  BuiltOrder,
  BuiltCancel,
  BuiltWithdraw,
  StreamAuthContext,
  BuiltStreamAuth,
} from "./execute.js";
export type { NadoGateway, SubmitOrderResult, CancelResult } from "./gateway.js";
export { createLiveNadoGateway } from "./live-gateway.js";
export type { TransportLike, LimiterLike } from "./live-gateway.js";
export type { LiveNadoGatewayDeps } from "./live-gateway.js";
export type { NadoOrderParams, NadoCancelParams, NadoWithdrawParams } from "./execute.js";
export { validateOrder } from "./validate.js";
export type { ValidatedOrder, OrderViolation, OrderViolationCode } from "./validate.js";
export { nadoMarketSizing, clampOrderSize } from "./sizing.js";
export type { NadoMarketSizing, ClampOrderSizeOpts } from "./sizing.js";
