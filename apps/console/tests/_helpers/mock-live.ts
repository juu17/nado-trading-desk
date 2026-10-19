// =============================================================================
// Browser-edge mocks for the live sequencer, so the WS subscribe -> route -> reconcile
// path runs fully offline + deterministic (no real testnet, no funded cohort). Three seams:
//   1. GET /api/nado/state      -> page.route, canned LiveConfig (flips the client to live)
//   2. POST /api/nado/relay/**  -> page.route, canned/aborted reads (reconcile targets)
//   3. the public WS            -> page.routeWebSocket, a pure mock (no real server)
// The config's wsSubscribeUrl is OWNED by the test, so it always matches the WS route.
// =============================================================================
import type { Page, Route, WebSocketRoute } from "@playwright/test";

// A test-owned wss:// origin (CSP connect-src allows wss: in every mode). The mock intercepts
// it before any real socket opens, so the host never needs to resolve.
export const MOCK_WS_URL = "wss://mock.nado.test/subscribe";
const MOCK_WS_PATTERN = "wss://mock.nado.test/**";

const BTC_PERP = {
  marketId: "nado:perp:BTC-PERP", productId: 2, symbol: "BTC-PERP",
  kind: "perp" as const, tickSize: "0.1", stepSize: "0.001", minSize: "0.001",
};

/** The canned public config the client reads from /api/nado/state (shape = LiveConfig). */
export function liveConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    chainId: 763373,
    endpoint: "0x698D87105274292B5673367DEC81874Ce3633Ac2",
    wsSubscribeUrl: MOCK_WS_URL,
    defaultProduct: BTC_PERP,
    markets: [],
    products: [BTC_PERP],
    ...overrides,
  };
}

/** Flip the client to live mode with a deterministic config. */
export async function mockState(page: Page, cfg: Record<string, unknown> = liveConfig()): Promise<void> {
  await page.route("**/api/nado/state", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(cfg) }),
  );
}

/** Mock the per-subaccount direct-deposit-address route (GET /api/nado/dda?owner=…). */
export async function mockDda(page: Page, address: string): Promise<void> {
  await page.route("**/api/nado/dda**", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ address }) }),
  );
}

export type RelayQuery = { type?: string; subaccount?: string; sender?: string; product_id?: number; product_ids?: number[] };
export interface RelayOpts {
  onQuery?: (q: RelayQuery) => void;
  /** Per-subaccount open-order count the mock reports, keyed by LOWERCASED subaccount hex. A live
   *  reference the test can mutate AFTER unlock (once subaccounts are known) to drive a reconcile. */
  orders?: Map<string, number>;
  /** Hold every order-book (`market_liquidity`) reply until this settles — lets a test land the book
   *  at a moment of its choosing (e.g. mid-click) to prove the drawer layout doesn't shift. */
  bookGate?: Promise<unknown>;
}

// A subaccount summary's account health is read unconditionally as a 3-tuple [initial, maintenance,
// unweighted] (mapSubaccountSummaryState reads healths[0..2]), so an empty summary still needs it.
const THREE_ZERO_HEALTHS = [0, 1, 2].map(() => ({ health: "0", assets: "0", liabilities: "0" }));

/** One raw server order the SDK's mapEngineServerOrder accepts (appendix "0" unpacks to defaults). */
function rawOrder(sender: string, i: number): Record<string, unknown> {
  return {
    sender, product_id: 2,
    digest: "0x" + String(i + 1).padStart(64, "0"),
    expiration: "0", nonce: String(i + 1),
    price_x18: "1000000000000000000000", // 1000 (x18)
    amount: "1000000000000000000",        // 1 unit (x18), positive = buy
    unfilled_amount: "1000000000000000000",
    placed_at: 0, appendix: "0",
  };
}

/** The inner `data` the @nadohq/engine-client query mapper consumes, per request `type`. The HTTP
 *  envelope the SDK expects is { status: "success", data: <this> } and it returns `data.data`.
 *  Shapes checked against @nadohq/engine-client@0.58.0 queryDataMappers: `subaccount_info` needs the
 *  3-entry `healths` tuple (read unconditionally, even when balances are empty); `orders` needs
 *  `product_orders`; `market_price` needs ask_x18/bid_x18. */
function relayData(body: RelayQuery, orders?: Map<string, number>): unknown {
  switch (body?.type) {
    case "subaccount_info":
      return { exists: true, spot_balances: [], perp_balances: [], spot_products: [], perp_products: [], health_contributions: {}, healths: THREE_ZERO_HEALTHS };
    case "orders": {
      const n = orders?.get((body.sender ?? "").toLowerCase()) ?? 0;
      const productId = body.product_ids?.[0] ?? 2;
      return { product_orders: n > 0 ? [{ product_id: productId, orders: Array.from({ length: n }, (_, i) => rawOrder(body.sender!, i)) }] : [] };
    }
    case "market_price":
      return { product_id: body.product_id ?? 2, ask_x18: "0", bid_x18: "0" };
    case "market_liquidity":
      // raw tick = [price_x18, size_x18]; the SDK maps price -> human, liquidity -> X18 size.
      return {
        bids: [["995000000000000000000", "2000000000000000000"], ["994000000000000000000", "5000000000000000000"]],
        asks: [["1005000000000000000000", "3000000000000000000"], ["1006000000000000000000", "4000000000000000000"]],
      };
    default:
      return {};
  }
}

/** Fulfill every relay read with a VALID engine envelope so reconciles complete offline + clean
 *  (no ERR_FAILED, no mapper throw). `onQuery` observes each forwarded read; `orders` lets a test
 *  make a subaccount report N open orders (mutate it after unlock, then trigger a reconcile). A
 *  read's subaccount is `subaccount` (summary) or `sender` (orders). */
export async function mockRelay(page: Page, opts: RelayOpts = {}): Promise<void> {
  await page.route("**/api/nado/relay/**", async (route: Route) => {
    let body: RelayQuery = {};
    try { body = JSON.parse(route.request().postData() ?? "{}") as RelayQuery; } catch { /* non-JSON */ }
    opts.onQuery?.(body);
    if (body.type === "market_liquidity" && opts.bookGate) await opts.bookGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "success", data: relayData(body, opts.orders) }) });
  });
}

/** The subaccount hex a relay read targets (summary uses `subaccount`, orders uses `sender`). */
export function querySubaccount(q: RelayQuery): string | undefined {
  return (q.subaccount ?? q.sender)?.toLowerCase();
}

export interface NativeRpcOpts {
  /** Native gas (WEI) every address reports by default. 0 = unfunded-gas. */
  defaultWei?: bigint;
  /** Per-owner-address (lowercased) WEI override — a live reference a test can mutate pre-assert. */
  balances?: Map<string, bigint>;
  /** Observe each eth_getBalance owner (lowercased). */
  onCall?: (owner: string) => void;
}

/** Mock the KEYLESS native-gas read (eth_getBalance to the Ink RPC) the readiness path fires on every
 *  reconcile. CSP allows any https origin, so without this the tab would hit the REAL testnet RPC —
 *  slow + non-deterministic. Matched by RegExp (the RPC URL is bare-origin, no path). Non-balance
 *  methods (e.g. the deposit-path eth_call) get a benign empty result so nothing throws. */
export async function mockNativeRpc(page: Page, opts: NativeRpcOpts = {}): Promise<void> {
  await page.route(/rpc-gel-sepolia\.inkonchain\.com/, async (route: Route) => {
    let body: { method?: string; id?: number; params?: unknown[] } = {};
    try { body = JSON.parse(route.request().postData() ?? "{}"); } catch { /* non-JSON */ }
    const id = body.id ?? 1;
    if (body.method === "eth_getBalance") {
      const owner = String(body.params?.[0] ?? "").toLowerCase();
      opts.onCall?.(owner);
      const wei = opts.balances?.get(owner) ?? opts.defaultWei ?? 0n;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id, result: "0x" + wei.toString(16) }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id, result: "0x" }) });
  });
}

const INK_CHAIN_HEX = "0x" + (763373).toString(16);
export interface InkRpcOpts {
  /** Per-owner-address (lowercased) WEI balance. A live reference a test can mutate pre-assert. */
  balances?: Map<string, bigint>;
  defaultWei?: bigint;
  /** Canned eth_sendRawTransaction hash. */
  txHash?: string;
  /** Mined receipt status: "0x1" success (default), "0x0" revert. */
  receiptStatus?: "0x1" | "0x0";
  /** Observe each JSON-RPC call (method + params) — lets a test assert a broadcast fired. */
  onCall?: (method: string, params: unknown[]) => void;
}

/** A COMPLETE Ink JSON-RPC mock: eth_getBalance PLUS the autofill + broadcast method set a wative native
 *  send drives (chainId / gasPrice / fees / estimateGas / nonce / sendRawTransaction / receipt). Keyless
 *  signing is real (in-tab crypto needs no network); only the RPC reads/submits are mocked, so the full
 *  refuel build→sign→broadcast→receipt path runs offline + deterministic. Unknown methods return `0x`. */
export async function mockInkRpc(page: Page, opts: InkRpcOpts = {}): Promise<void> {
  const txHash = opts.txHash ?? ("0x" + "ab".repeat(32));
  const status = opts.receiptStatus ?? "0x1";
  await page.route(/rpc-gel-sepolia\.inkonchain\.com/, async (route: Route) => {
    let body: { method?: string; id?: number; params?: unknown[] } = {};
    try { body = JSON.parse(route.request().postData() ?? "{}"); } catch { /* non-JSON */ }
    const id = body.id ?? 1;
    const method = body.method ?? "";
    const params = body.params ?? [];
    opts.onCall?.(method, params);
    const reply = (result: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id, result }) });
    switch (method) {
      case "eth_getBalance": {
        const owner = String(params[0] ?? "").toLowerCase();
        return reply("0x" + (opts.balances?.get(owner) ?? opts.defaultWei ?? 0n).toString(16));
      }
      case "eth_chainId": return reply(INK_CHAIN_HEX);
      case "eth_gasPrice": return reply("0x3b9aca00");             // 1 gwei
      case "eth_maxPriorityFeePerGas": return reply("0x3b9aca00");
      case "eth_estimateGas": return reply("0x5208");             // 21000
      case "eth_getTransactionCount": return reply("0x0");        // pending nonce 0
      case "eth_blockNumber": return reply("0x1");
      case "eth_sendRawTransaction": return reply(txHash);
      case "eth_getTransactionReceipt":
        return reply({ transactionHash: txHash, status, blockNumber: "0x1", blockHash: "0x" + "cd".repeat(32), gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00", logs: [], logsBloom: "0x" + "0".repeat(512), type: "0x2", from: "0x" + "0".repeat(40), to: "0x" + "0".repeat(40), transactionIndex: "0x0", contractAddress: null });
      case "eth_getBlockByNumber":
        return reply({ number: "0x1", baseFeePerGas: "0x3b9aca00", timestamp: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x5208" });
      case "eth_feeHistory":
        return reply({ baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"], gasUsedRatio: [0.5], oldestBlock: "0x1", reward: [["0x3b9aca00"]] });
      default: return reply("0x");
    }
  });
}

type Sub = { type: string; subaccount: string };

/** A pure-mock sequencer over page.routeWebSocket. It never connects to a real server; it
 *  passively learns each cohort subaccount from the client's own subscribe frames, acks the
 *  authed order_update `authenticate` frame (so the drawer socket doesn't churn), and lets a
 *  test push synthetic fill / position_change frames to the public socket on demand. */
export class MockSequencer {
  readonly subscribes: Sub[] = [];
  authFrames = 0;
  private lastPublic: WebSocketRoute | null = null;

  async install(page: Page): Promise<void> {
    await page.routeWebSocket(MOCK_WS_PATTERN, (ws: WebSocketRoute) => {
      ws.onMessage((raw) => {
        let m: { id?: number; method?: string; stream?: { type?: string; subaccount?: string } };
        try { m = JSON.parse(String(raw)); } catch { return; }
        if (m.method === "authenticate") {
          this.authFrames++;
          ws.send(JSON.stringify({ id: m.id, result: null })); // ack -> order_update may subscribe
          return;
        }
        if (m.method === "subscribe" && m.stream?.type && m.stream.subaccount) {
          this.subscribes.push({ type: m.stream.type, subaccount: m.stream.subaccount });
          if (m.stream.type !== "order_update") this.lastPublic = ws; // the public multiplex socket
        }
      });
    });
  }

  /** Distinct cohort subaccounts seen on the public (fill/position_change) socket, in order. */
  publicSubaccounts(): string[] {
    const out: string[] = [];
    for (const s of this.subscribes) if (s.type !== "order_update" && !out.includes(s.subaccount)) out.push(s.subaccount);
    return out;
  }

  /** Stream types subscribed for a given subaccount (e.g. ['fill','position_change']). */
  typesFor(subaccount: string): string[] {
    return this.subscribes.filter((s) => s.subaccount === subaccount).map((s) => s.type);
  }

  private emit(frame: Record<string, unknown>): void {
    if (!this.lastPublic) throw new Error("no public WS socket yet — unlock a cohort first");
    this.lastPublic.send(JSON.stringify(frame));
  }

  emitFill(subaccount: string, over: Record<string, unknown> = {}): void {
    this.emit({ type: "fill", subaccount, order_digest: "0x" + "a".repeat(64), filled_qty: "1", is_taker: true, is_bid: true, ...over });
  }

  emitPositionChange(subaccount: string, reason = "settle_pnl", over: Record<string, unknown> = {}): void {
    this.emit({ type: "position_change", subaccount, amount: "1", reason, ...over });
  }
}

/** Pass the app ENTRY GATE on a fresh Playwright context (no vault yet → onboarding): set a vault
 *  password and create the empty vault, so the gate unmounts and the app renders. Every test that
 *  reaches the app must call this (or unlockGeneratedCohort, which folds it in) right after goto("/").
 *  `exact` placeholder match so "vault password" doesn't also select "confirm vault password". */
export async function passGate(page: Page, password = "test-pw-123"): Promise<void> {
  await page.getByPlaceholder("vault password", { exact: true }).fill(password);
  await page.getByPlaceholder("confirm vault password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create vault" }).click();
  // The gate unmounts and the app (which hosts the custody panel) renders.
  await page.getByText(/In-browser custody/i).waitFor({ timeout: 30_000 });
}

/** Drive the already-open CustodyPanel to generate a fresh N-wallet in-tab cohort (real wative-core
 *  browser crypto + IndexedDB — the shipped Stage 2b path), then wait until it is unlocked. The vault
 *  must already be open (call passGate first); split from passGate so a test can assert the app's
 *  "locked" state between the two. */
export async function generateCohortViaPanel(page: Page, password = "test-pw-123"): Promise<void> {
  await page.getByPlaceholder("workspace password").fill(password);
  await page.getByRole("button", { name: /Generate \d+ in-tab/ }).click();
  // The panel header flips to "unlocked" and lists the generated wallets.
  await page.getByText(/In-browser custody · unlocked/i).waitFor({ timeout: 30_000 });
}

/** Pass the entry gate, then generate a fresh in-tab cohort. The gate password and the custody
 *  password are the same here. The common path for every test that needs a live cohort. */
export async function unlockGeneratedCohort(page: Page, password = "test-pw-123"): Promise<void> {
  await passGate(page, password);
  await generateCohortViaPanel(page, password);
}
