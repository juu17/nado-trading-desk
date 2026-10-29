import { describe, expect, it } from "vitest";
import { KnownOrderNotSent, OrderLedger, knownOrderNotSentReason, type ProtectedOrderConnector } from "./order-ledger.js";
import { emptyOperations, type DeskOperations, type FundingChainId, type OperationsStore } from "./types.js";

class Store implements OperationsStore {
  state = emptyOperations();
  lane: Promise<unknown> = Promise.resolve();
  afterClaim?: () => Promise<void>;
  async read() { return structuredClone(this.state); }
  async update<T>(fn: (state: DeskOperations) => T): Promise<T> {
    const work = this.lane.then(() => { const copy = structuredClone(this.state), result = fn(copy); this.state = copy; return structuredClone(result); });
    this.lane = work.catch(() => {});
    const result = await work;
    if (this.afterClaim && this.state.orders.some(o => o.state === "DISPATCHED")) { const hook = this.afterClaim; this.afterClaim = undefined; await hook(); }
    return result;
  }
}
async function fixture(chainId: FundingChainId) {
  const store = new Store(); let sends = 0;
  const connector: ProtectedOrderConnector = {
    dispatch: async (order, allowed) => { if (!allowed()) throw Error("STOPPED"); sends++; return order.digest; },
    lookup: async order => ({ digest: order.digest, owner: order.owner, productId: order.productId, quantityX18: order.quantityX18, filledX18: "0", known: false }),
  };
  const ledger = new OrderLedger(store, connector, chainId); await ledger.enable();
  const input = { id: "local-stop-order", owner: "0x" + "1".repeat(40), chainId, productId: 2, digest: "0x" + "a".repeat(64),
    payload: "random-unfunded-test-intent", quantityX18: "100", side: "BUY" as const, priceX18: "1000", nonce: "10", expiration: 1000 };
  return { store, ledger, connector, input, get sends() { return sends; } };
}
describe("positive local evidence before any dispatch invocation", () => {
  for (const chain of [763373, 57073] as const) it(`${chain}: Stop after durable claim is terminal unsent and never changes or reuses the nonce`, async () => {
    const x = await fixture(chain); x.store.afterClaim = () => x.ledger.stop();
    const row = await x.ledger.submit(x.input);
    expect(x.sends).toBe(0);
    expect(row).toMatchObject({ state: "REJECTED", filledX18: "0", cleared: true, nonce: x.input.nonce, digest: x.input.digest });
    expect(row.errorCode).toMatch(/^ORDER_NOT_SENT_/);
    expect((await x.ledger.reconcile(x.input.id)).state).toBe("REJECTED");
    await x.ledger.enable(); expect((await x.ledger.submit(x.input)).state).toBe("REJECTED");
    await expect(x.ledger.submit({ ...x.input, id: "different-order", digest: "0x" + "b".repeat(64) })).rejects.toThrow("RESERVED");
    expect(x.sends).toBe(0); expect(x.store.state.orders).toHaveLength(1);
  });
  for (const chain of [763373, 57073] as const) {
    it(`${chain}: only the trusted no-send type can finish a transport-preflight rejection`, async () => {
      const x = await fixture(chain);
      x.connector.dispatch = async () => { throw new KnownOrderNotSent("TRADING_STOPPED"); };
      const row = await x.ledger.submit(x.input);
      expect(row.state).toBe("REJECTED"); expect(knownOrderNotSentReason(row)).toBe("TRADING_STOPPED");
      expect(x.sends).toBe(0); expect(row.nonce).toBe(x.input.nonce);
    });
    it(`${chain}: a plain error whose message looks like the local certificate remains unknown`, async () => {
      const x = await fixture(chain); let attempts = 0;
      x.connector.dispatch = async () => { attempts++; throw Error("ORDER_NOT_SENT_TRADING_STOPPED"); };
      const row = await x.ledger.submit(x.input);
      expect(row.state).toBe("UNKNOWN"); expect(knownOrderNotSentReason(row)).toBeUndefined();
      await expect(x.ledger.enable()).rejects.toThrow("UNRESOLVED_ORDER");
      expect(attempts).toBe(1); expect(row.nonce).toBe(x.input.nonce);
    });
  }
});
