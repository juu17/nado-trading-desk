// =============================================================================
// @farm/adapter-nado · gateway boundary — the Nado off-chain sequencer client
// (REST + WS). This is the ONE live-network surface of the adapter; its concrete
// HTTP/WS implementation (over AdapterEnv.request / openSocket, against the real
// Nado endpoints) is built + verified at the testnet gate. The adapter is wired
// against this INTERFACE so its execute/plan logic is unit-testable offline with a
// fake gateway.
// =============================================================================
import type {
  Market, MarketId, OrderBook, Order, Position, Fill, Balance, Hex,
} from "@farm/adapter-api";
import type { BuiltOrder, BuiltCancel } from "./execute.js";

export interface SubmitOrderResult { digest: string; status: string; raw: unknown }
export interface CancelResult { cancelled: string[]; raw: unknown }

export interface NadoGateway {
  submitOrder(signed: BuiltOrder & { signature: Hex | Uint8Array }): Promise<SubmitOrderResult>;
  cancelOrders(signed: BuiltCancel & { signature: Hex | Uint8Array }): Promise<CancelResult>;
  getMarkets(): Promise<Market[]>;
  getOrderBook(market: MarketId, depth?: number): Promise<OrderBook>;
  getPositions(subaccount: string): Promise<Position[]>;
  getOpenOrders(subaccount: string): Promise<Order[]>;
  getFills(subaccount: string, since?: number): Promise<Fill[]>;
  getBalances(subaccount: string): Promise<Balance[]>;
}
