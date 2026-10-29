// The density unlock, proven end-to-end over the real sharded store: with the
// admission gate re-scoped PER WALLET, one wallet's in-flight (DISPATCHED) order no
// longer blocks another wallet from dispatching + ACKing. This test FAILS under the
// port's original GLOBAL gate (B would refuse UNRESOLVED_ORDER while A is in flight).
import { describe, it, expect } from "vitest";
import { OrderLedger, type ProtectedOrderConnector } from "./order-ledger.js";
import { InMemoryOperationsStore } from "./store.js";
import { emptyOperations, refuse, type DeskOperations, type OperationsStore, type ProtectedOrder } from "./types.js";

// A plain NON-sharded store (only {read, update}, like the ported fault-path mocks),
// so OrderLedger.perOwner takes the GLOBAL `update` fallback — the path where the
// per-wallet `o.owner === input.owner` admission FILTER (not the store sharding) is
// what gives per-wallet semantics.
class GlobalStore implements OperationsStore {
  state = emptyOperations();
  private lane: Promise<unknown> = Promise.resolve();
  async read() { return structuredClone(this.state); }
  update<T>(fn: (s: DeskOperations) => T): Promise<T> {
    const p = this.lane.then(() => {
      const copy = structuredClone(this.state), r = fn(copy);
      this.state = copy;
      return structuredClone(r);
    });
    this.lane = p.catch(() => {});
    return p;
  }
}

const A = "0x" + "1".repeat(40);
const B = "0x" + "2".repeat(40);

function input(owner: string, id: string, digest: string, nonce: string) {
  return {
    id, owner, chainId: 763373, productId: 2, digest,
    payload: "signed", quantityX18: "100", side: "BUY" as const,
    priceX18: "1000", nonce, expiration: 1000,
  };
}

describe("per-wallet concurrency over the sharded store", () => {
  it("🎯 wallet B dispatches + ACKs while wallet A is held in-flight (density unlock)", async () => {
    const store = new InMemoryOperationsStore();
    let releaseA!: (digest: string) => void;
    let aEntered!: () => void;
    const aDispatched = new Promise<void>((r) => (aEntered = r));
    const aHeld = new Promise<string>((r) => (releaseA = r));
    const connector: ProtectedOrderConnector = {
      dispatch: async (o) => {
        if (o.owner === A) { aEntered(); return aHeld; } // hang until released
        return o.digest; // B (and anyone else) dispatch immediately
      },
      lookup: async (o) => ({ digest: o.digest, owner: o.owner, productId: o.productId, quantityX18: o.quantityX18, filledX18: "0", known: true }),
    };
    const ledger = new OrderLedger(store, connector, 763373);
    await ledger.enable();

    const aInput = input(A, "a1", "0x" + "a".repeat(64), "10");
    const bInput = input(B, "b1", "0x" + "b".repeat(64), "20");

    const aPromise = ledger.submit(aInput); // will hang in dispatch
    await aDispatched; // A's order is now DISPATCHED and in flight

    // B must NOT be blocked by A's in-flight order (per-wallet gate).
    const bRow = await ledger.submit(bInput);
    expect(bRow.state).toBe("ACKED");

    // A is still in flight; release it and confirm it ACKs too.
    releaseA(aInput.digest);
    expect((await aPromise).state).toBe("ACKED");

    const all = await store.read();
    expect(all.orders.map((o) => o.id).sort()).toEqual(["a1", "b1"]);
    expect(all.tradingStopped).toBe(false);
  });

  it("the same wallet is still single-in-flight (per-wallet gate holds)", async () => {
    const store = new InMemoryOperationsStore();
    let releaseA!: (d: string) => void;
    let aEntered!: () => void;
    const aDispatched = new Promise<void>((r) => (aEntered = r));
    const aHeld = new Promise<string>((r) => (releaseA = r));
    const connector: ProtectedOrderConnector = {
      dispatch: async (o) => { aEntered(); return aHeld; },
      lookup: async (o) => ({ digest: o.digest, owner: o.owner, productId: o.productId, quantityX18: o.quantityX18, filledX18: "0", known: true }),
    };
    const ledger = new OrderLedger(store, connector, 763373);
    await ledger.enable();
    const a1 = ledger.submit(input(A, "a1", "0x" + "a".repeat(64), "10"));
    await aDispatched;
    // A second order for the SAME wallet while a1 is in flight is refused.
    await expect(
      ledger.submit(input(A, "a2", "0x" + "c".repeat(64), "11")),
    ).rejects.toThrow("UNRESOLVED_ORDER");
    releaseA("0x" + "a".repeat(64));
    expect((await a1).state).toBe("ACKED");
  });

  it("per-wallet admission FILTER holds on the non-sharded fallback path too", async () => {
    // Same scenario over a plain {read,update} store: B must not be blocked by A's
    // in-flight order. Here the store scans ALL orders, so only the explicit
    // `o.owner === input.owner` filter keeps it per-wallet (this test fails if that
    // filter is reverted to the port's global gate).
    const store = new GlobalStore();
    let releaseA!: (d: string) => void;
    let aEntered!: () => void;
    const aDispatched = new Promise<void>((r) => (aEntered = r));
    const aHeld = new Promise<string>((r) => (releaseA = r));
    const connector: ProtectedOrderConnector = {
      dispatch: async (o) => { if (o.owner === A) { aEntered(); return aHeld; } return o.digest; },
      lookup: async (o) => ({ digest: o.digest, owner: o.owner, productId: o.productId, quantityX18: o.quantityX18, filledX18: "0", known: true }),
    };
    const ledger = new OrderLedger(store, connector, 763373);
    await ledger.enable();
    const aP = ledger.submit(input(A, "a1", "0x" + "a".repeat(64), "10"));
    await aDispatched;
    expect((await ledger.submit(input(B, "b1", "0x" + "b".repeat(64), "20"))).state).toBe("ACKED");
    releaseA("0x" + "a".repeat(64));
    expect((await aP).state).toBe("ACKED");
  });

  it("same owner + same id is idempotent over the sharded store (no double send)", async () => {
    const store = new InMemoryOperationsStore();
    let sends = 0;
    const connector: ProtectedOrderConnector = {
      dispatch: async (o) => { sends++; return o.digest; },
      lookup: async (o) => ({ digest: o.digest, owner: o.owner, productId: o.productId, quantityX18: o.quantityX18, filledX18: "0", known: true }),
    };
    const ledger = new OrderLedger(store, connector, 763373);
    await ledger.enable();
    const dup = input(A, "dup-1", "0x" + "a".repeat(64), "10");
    await ledger.submit(dup);
    await ledger.submit(dup); // retry same (owner,id) → resolved, not re-sent
    expect(sends).toBe(1);
    expect((await store.read()).orders).toHaveLength(1);
  });

  it("the injected admit hook (Phase-A seam) can refuse an order", async () => {
    const store = new InMemoryOperationsStore();
    const connector: ProtectedOrderConnector = {
      dispatch: async (o) => o.digest,
      lookup: async (o) => ({ digest: o.digest, owner: o.owner, productId: o.productId, quantityX18: o.quantityX18, filledX18: "0", known: true }),
    };
    const admit = (_s: DeskOperations, i: Omit<ProtectedOrder, "state" | "filledX18" | "createdAt">) => {
      if (i.id.startsWith("forbidden")) refuse("EXPERIMENT_WALLET_RESERVED");
    };
    const ledger = new OrderLedger(store, connector, 763373, admit);
    await ledger.enable();
    await expect(
      ledger.submit(input(A, "forbidden-1", "0x" + "a".repeat(64), "10")),
    ).rejects.toThrow("EXPERIMENT_WALLET_RESERVED");
    // an allowed order still goes through
    expect((await ledger.submit(input(A, "ok-1", "0x" + "d".repeat(64), "11"))).state).toBe("ACKED");
  });
});
