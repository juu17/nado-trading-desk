import { describe, expect, it } from "vitest";
import { KnownOrderRejection, OrderLedger, type ProtectedOrderConnector } from "./order-ledger.js";
import { emptyOperations, type DeskOperations, type FundingChainId, type OperationsStore } from "./types.js";

class Store implements OperationsStore {
  state = emptyOperations(); lane: Promise<unknown> = Promise.resolve();
  beforeNext?: () => Promise<void>;
  async read() { return structuredClone(this.state); }
  update<T>(fn: (s: DeskOperations) => T): Promise<T> {
    const work = this.lane.then(async () => { const hook = this.beforeNext; this.beforeNext = undefined; await hook?.(); const next = structuredClone(this.state), result = fn(next); this.state = next; return structuredClone(result); });
    this.lane = work.catch(() => {}); return work;
  }
}
async function pending(chainId: FundingChainId) {
  const store = new Store(); let fail!: (error: Error) => void, complete!: (digest: string) => void, entered!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; }), response = new Promise<string>((resolve, reject) => { complete = resolve; fail = reject; });
  const input = { id: "original-send", owner: "0x" + "1".repeat(40), chainId, productId: 2, digest: "0x" + "a".repeat(64), payload: "unfunded-intent", quantityX18: "100", side: "BUY" as const, priceX18: "1000", nonce: "10", expiration: 1000 };
  let sends = 0;
  const connector: ProtectedOrderConnector = { dispatch: async () => { sends++; entered(); return response; }, lookup: async order => ({ digest: order.digest, owner: order.owner, productId: order.productId, quantityX18: order.quantityX18, filledX18: "50", known: true }) };
  const ledger = new OrderLedger(store, connector, chainId); await ledger.enable();
  const result = ledger.submit(input); await began;
  return { store, ledger, connector, input, result, fail, complete, get sends() { return sends; } };
}
describe("late transport responses after positive original reconciliation", () => {
  for (const chain of [763373, 57073] as const) {
    it(`${chain}: an old lost response cannot stop an explicitly enabled newer session after the original ACK is proven`, async () => {
      const x = await pending(chain); await x.ledger.stop(); expect((await x.ledger.reconcile(x.input.id)).state).toBe("ACKED"); await x.ledger.enable();
      x.fail(Error("OLD_ACK_LOST")); const row = await x.result;
      expect(row).toMatchObject({ state: "ACKED", filledX18: "50", nonce: "10" }); expect(x.store.state.tradingStopped).toBe(false);
      x.connector.dispatch = async order => order.digest;
      await expect(x.ledger.submit({ ...x.input, id: "new-session-order", digest: "0x" + "b".repeat(64), nonce: "11" })).resolves.toMatchObject({ state: "ACKED" });
      expect(x.sends).toBe(1);
    });
    it(`${chain}: preserving a known result never enables an intentionally stopped session`, async () => {
      const x = await pending(chain); await x.ledger.stop(); await x.ledger.reconcile(x.input.id);
      x.fail(Error("OLD_ACK_LOST")); expect((await x.result).state).toBe("ACKED"); expect(x.store.state.tradingStopped).toBe(true);
      await expect(x.ledger.submit({ ...x.input, id: "new", digest: "0x" + "b".repeat(64), nonce: "11" })).rejects.toThrow("TRADING_STOPPED");
      expect(x.sends).toBe(1);
    });
    it(`${chain}: a later market refusal cannot replace already confirmed partial execution with rejection`, async () => {
      const x = await pending(chain); await x.ledger.stop(); await x.ledger.reconcile(x.input.id); await x.ledger.enable();
      x.fail(new KnownOrderRejection(2006, false)); const row = await x.result;
      expect(row).toMatchObject({ state: "ACKED", filledX18: "50", nonce: "10" }); expect(row.cleared).not.toBe(true); expect(x.store.state.tradingStopped).toBe(false);
      expect(x.sends).toBe(1);
    });
    it(`${chain}: a contradictory fatal refusal still stops for review while retaining confirmed execution`, async () => {
      const x = await pending(chain); await x.ledger.stop(); await x.ledger.reconcile(x.input.id); await x.ledger.enable();
      x.fail(new KnownOrderRejection(2035, true)); const row = await x.result;
      expect(row).toMatchObject({ state: "ACKED", filledX18: "50", nonce: "10", errorCode: "ORDER_ACK_REJECTION_CONFLICT_2035" }); expect(x.store.state.tradingStopped).toBe(true); expect(x.sends).toBe(1);
    });
    it(`${chain}: a current lookup failure still revokes permission even for an earlier ACK`, async () => {
      const x = await pending(chain); await x.ledger.stop(); await x.ledger.reconcile(x.input.id); await x.ledger.enable();
      x.fail(Error("OLD_ACK_LOST")); await x.result; await x.ledger.enable();
      x.connector.lookup = async order => ({ digest: order.digest, owner: order.owner, productId: order.productId, quantityX18: order.quantityX18, filledX18: "0", known: false });
      await x.ledger.reconcile(x.input.id); expect(x.store.state.tradingStopped).toBe(true); expect(x.store.state.orders[0]!.filledX18).toBe("50");
    });
    it(`${chain}: an actual mismatching ACK still stops for review rather than being treated as a lost response`, async () => {
      const x = await pending(chain); await x.ledger.stop(); await x.ledger.reconcile(x.input.id); await x.ledger.enable();
      x.complete("0x" + "b".repeat(64)); const row = await x.result;
      expect(row).toMatchObject({state:"ACKED",filledX18:"50",nonce:"10"});expect(x.store.state.tradingStopped).toBe(true);expect(x.sends).toBe(1);
    });
    it(`${chain}: the durable unresolved claim blocks another send while unknown classification waits for the writer`, async () => {
      const x = await pending(chain); let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
      x.store.beforeNext = async () => { entered(); await gate; }; x.fail(Error("ACK_LOST")); await reached;
      const next = x.ledger.submit({ ...x.input, id: "must-not-send", digest: "0x" + "b".repeat(64), nonce: "11" });
      const blocked = expect(next).rejects.toThrow(/TRADING_STOPPED|UNRESOLVED_ORDER/);
      expect(x.sends).toBe(1); release(); expect((await x.result).state).toBe("UNKNOWN"); await blocked;
      expect(x.sends).toBe(1); expect(x.store.state.orders).toHaveLength(1); expect(x.store.state.tradingStopped).toBe(true);
    });
  }
});
