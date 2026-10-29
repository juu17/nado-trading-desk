import { describe, it, expect } from "vitest";
import { KnownOrderRejection, OrderLedger, type ProtectedOrderConnector } from "./order-ledger.js";
import {
  emptyOperations,
  type OperationsStore,
  type DeskOperations,
} from "./types.js";
import { validateDeskOperations } from "./journal.js";
const A = "0x" + "1".repeat(40),
  D = "0x" + "a".repeat(64);
class Store implements OperationsStore {
  state = emptyOperations();
  lane: Promise<unknown> = Promise.resolve();
  fail = false;
  async read() {
    return structuredClone(this.state);
  }
  update<T>(fn: (v: DeskOperations) => T): Promise<T> {
    const p = this.lane.then(() => {
      if (this.fail) throw Error("DISK_FULL");
      const copy = structuredClone(this.state),
        r = fn(copy);
      this.state = copy;
      return structuredClone(r);
    });
    this.lane = p.catch(() => {});
    return p;
  }
}
async function setup() {
  const s = new Store();
  let sends = 0;
  const c: ProtectedOrderConnector = {
    dispatch: async (o, allowed) => {
      if (!allowed()) throw Error("STOPPED");
      sends++;
      return o.digest;
    },
    lookup: async (o) => ({
      digest: o.digest,
      owner: o.owner,
      productId: o.productId,
      quantityX18: o.quantityX18,
      filledX18: "50",
      known: true,
    }),
  };
  const l = new OrderLedger(s, c, 763373);
  await l.enable();
  const input = {
    id: "job-1",
    owner: A,
    chainId: 763373 as const,
    productId: 2,
    digest: D,
    payload: "private-signed-order",
    quantityX18: "100",
    side: "BUY" as const,
    priceX18: "1000",
    nonce: "10",
    expiration: 1000,
  };
  return {
    s,
    c,
    l,
    input,
    get sends() {
      return sends;
    },
  };
}
describe("ordinary order persistent single-dispatch", () => {
  it("a passive reserved intent remains blocking through recovery and is never ACKed or dispatched", async () => {
    const x = await setup();
    x.s.state.orders.push({ ...x.input, state: "DISPATCHED", filledX18: "0", createdAt: 1,
      purpose: "RISK_CLOSE", dispatchCount: 0, cancelEvidencePayload: "{}" });
    validateDeskOperations(structuredClone(x.s.state));
    await x.l.recover();
    expect((await x.l.reconcile(x.input.id)).state).toBe("UNKNOWN");
    await expect(x.l.enable()).rejects.toThrow("UNRESOLVED_ORDER");
    expect(x.sends).toBe(0);
    const bad = structuredClone(x.s.state);
    bad.orders[0]!.neverSent = true;
    expect(() => validateDeskOperations(bad)).toThrow("JOURNAL_DAMAGED");
  });
  it("duplicates and concurrent claims never send twice", async () => {
    const x = await setup();
    await Promise.allSettled([x.l.submit(x.input), x.l.submit(x.input)]);
    await x.l.submit(x.input);
    expect(x.sends).toBe(1);
    expect(x.s.state.orders).toHaveLength(1);
    expect(x.s.state.orders[0]!.payload).toBe("");
  });
  it("ACK loss is looked up after restart without any re-send", async () => {
    const x = await setup();
    let attempts = 0;
    x.c.dispatch = async () => {
      attempts++;
      throw Error("ACK_LOST");
    };
    expect((await x.l.submit(x.input)).state).toBe("UNKNOWN");
    const next = new OrderLedger(x.s, x.c, 763373);
    await next.recover();
    expect((await next.reconcile(x.input.id)).state).toBe("ACKED");
    expect(attempts).toBe(1);
  });
  it("changed request identities and reused owner nonces are refused", async () => {
    const x = await setup();
    await x.l.submit(x.input);
    await expect(
      x.l.submit({ ...x.input, digest: "0x" + "b".repeat(64) }),
    ).rejects.toThrow("CONFLICT");
    await expect(
      x.l.submit({ ...x.input, id: "job-2", digest: "0x" + "b".repeat(64) }),
    ).rejects.toThrow("RESERVED");
    expect(x.sends).toBe(1);
  });
  it("disk failure produces no gateway write", async () => {
    const x = await setup();
    x.s.fail = true;
    await expect(x.l.submit(x.input)).rejects.toThrow("DISK_FULL");
    expect(x.sends).toBe(0);
  });
  it("Stop during an asynchronous transport preflight prevents the actual send", async () => {
    const x = await setup();
    let sends = 0;
    x.c.dispatch = async (o, allowed) => {
      await x.l.stop();
      if (!allowed()) throw Error("STOPPED");
      sends++;
      return o.digest;
    };
    expect((await x.l.submit(x.input)).state).toBe("UNKNOWN");
    expect(sends).toBe(0);
  });
  it("a missing or mismatching remote order stays unknown and blocks further trading", async () => {
    const x = await setup();
    x.c.dispatch = async () => {
      throw Error("TIMEOUT");
    };
    await x.l.submit(x.input);
    x.c.lookup = async (o) => ({
      digest: o.digest,
      owner: A,
      productId: 2,
      quantityX18: "100",
      filledX18: "0",
      known: false,
    });
    expect((await x.l.reconcile(x.input.id)).state).toBe("UNKNOWN");
    await expect(x.l.enable()).rejects.toThrow("UNRESOLVED_ORDER");
  });
});
describe("exchange rejections", () => {
  it("a market refusal ends only that order; trading continues", async () => {
    const x = await setup();
    x.c.dispatch = async () => { throw new KnownOrderRejection(2008, false); };
    const row = await x.l.submit(x.input);
    expect(row).toMatchObject({ state: "REJECTED", cleared: true, errorCode: "ORDER_REFUSED_2008" });
    expect(x.s.state.tradingStopped).toBe(false);
    x.c.dispatch = async (o) => o.digest;
    const next = await x.l.submit({ ...x.input, id: "job-2", digest: "0x" + "b".repeat(64), nonce: "11" });
    expect(next.state).toBe("ACKED");
  });
  it("a malformed-request refusal still stops all trading", async () => {
    const x = await setup();
    x.c.dispatch = async () => { throw new KnownOrderRejection(2035); };
    expect((await x.l.submit(x.input)).state).toBe("REJECTED");
    expect(x.s.state.tradingStopped).toBe(true);
    await expect(x.l.submit({ ...x.input, id: "job-2", digest: "0x" + "b".repeat(64), nonce: "11" })).rejects.toThrow("TRADING_STOPPED");
  });
});
