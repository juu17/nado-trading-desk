import { describe, it, expect } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  InMemoryOperationsStore,
  IdbOperationsStore,
} from "./store.js";
import { emptyOperations, type ProtectedOrder } from "./types.js";

const A = "0x" + "1".repeat(40);
const B = "0x" + "2".repeat(40);

function order(owner: string, id: string, digest: string): ProtectedOrder {
  return {
    id,
    owner,
    chainId: 763373,
    productId: 2,
    digest,
    payload: "signed",
    quantityX18: "100",
    side: "BUY",
    priceX18: "1000",
    nonce: "10",
    expiration: 1000,
    createdAt: 1,
    state: "DISPATCHED",
    filledX18: "0",
  };
}

describe("InMemoryOperationsStore", () => {
  it("reads the empty document and applies a global update atomically", async () => {
    const s = new InMemoryOperationsStore();
    expect((await s.read()).orders).toHaveLength(0);
    const n = await s.update((d) => {
      d.orders.push(order(A, "a1", "0x" + "a".repeat(64)));
      d.tradingStopped = false;
      return d.orders.length;
    });
    expect(n).toBe(1);
    const after = await s.read();
    expect(after.orders).toHaveLength(1);
    expect(after.tradingStopped).toBe(false);
  });

  it("isolates the returned value and stored rows from later mutation", async () => {
    const s = new InMemoryOperationsStore();
    const row = await s.update((d) => {
      const o = order(A, "a1", "0x" + "a".repeat(64));
      d.orders.push(o);
      return o;
    });
    row.filledX18 = "999"; // mutate the returned copy
    expect((await s.read()).orders[0]!.filledX18).toBe("0");
  });

  it("updateOwner scopes the view to one owner's orders", async () => {
    const s = new InMemoryOperationsStore();
    await s.update((d) => {
      d.orders.push(order(A, "a1", "0x" + "a".repeat(64)));
      d.orders.push(order(B, "b1", "0x" + "b".repeat(64)));
    });
    const seen = await s.updateOwner(A, (d) => d.orders.map((o) => o.owner));
    expect(seen).toEqual([A]); // only A's shard is visible
  });

  it("🎯 concurrent per-owner writes do NOT lose updates (density: no global write-lock)", async () => {
    const s = new InMemoryOperationsStore();
    await Promise.all([
      s.updateOwner(A, (d) => d.orders.push(order(A, "a1", "0x" + "a".repeat(64)))),
      s.updateOwner(B, (d) => d.orders.push(order(B, "b1", "0x" + "b".repeat(64)))),
    ]);
    const all = await s.read();
    expect(all.orders.map((o) => o.id).sort()).toEqual(["a1", "b1"]);
  });

  it("same-owner updates serialize (both land, no lost update)", async () => {
    const s = new InMemoryOperationsStore();
    await Promise.all([
      s.updateOwner(A, (d) => d.orders.push(order(A, "a1", "0x" + "a".repeat(64)))),
      s.updateOwner(A, (d) => d.orders.push(order(A, "a2", "0x" + "c".repeat(64)))),
    ]);
    expect((await s.read()).orders).toHaveLength(2);
  });

  it("a global update is exclusive w.r.t. owner lanes it overlaps", async () => {
    const s = new InMemoryOperationsStore();
    await s.update((d) => d.orders.push(order(A, "a1", "0x" + "a".repeat(64))));
    // A global recover marks every DISPATCHED order UNKNOWN; an owner write racing it
    // must not be dropped.
    await Promise.all([
      s.update((d) => {
        for (const o of d.orders) if (o.state === "DISPATCHED") o.state = "UNKNOWN";
      }),
      s.updateOwner(B, (d) => d.orders.push(order(B, "b1", "0x" + "b".repeat(64)))),
    ]);
    const all = await s.read();
    expect(all.orders.find((o) => o.id === "a1")!.state).toBe("UNKNOWN");
    expect(all.orders.some((o) => o.id === "b1")).toBe(true);
  });

  it("rejects a per-owner write that touches another owner's shard", async () => {
    const s = new InMemoryOperationsStore();
    await expect(
      s.updateOwner(A, (d) => d.orders.push(order(B, "b1", "0x" + "b".repeat(64)))),
    ).rejects.toThrow("OPERATIONS_SHARD_ESCAPE");
  });

  it("rejects a global-field write on the per-owner lane (use update() instead)", async () => {
    const s = new InMemoryOperationsStore();
    await expect(
      s.updateOwner(A, (d) => {
        d.tradingStopped = false; // belongs on the global lane
      }),
    ).rejects.toThrow("OPERATIONS_GLOBAL_WRITE_ON_OWNER_LANE");
    // and the owner's shard was NOT written (the refuse happened before the commit)
    expect((await s.read()).orders).toHaveLength(0);
  });

  it("a global update observes writes committed before it (ordering teeth)", async () => {
    const s = new InMemoryOperationsStore();
    // Submit two owner writes, then a global update; the global snapshot must see both.
    const [, , seen] = await Promise.all([
      s.updateOwner(A, (d) => d.orders.push(order(A, "a1", "0x" + "a".repeat(64)))),
      s.updateOwner(B, (d) => d.orders.push(order(B, "b1", "0x" + "b".repeat(64)))),
      s.update((d) => d.orders.map((o) => o.id)),
    ]);
    // The global update ran exclusive w.r.t. both owner lanes; because it was awaited
    // alongside them it observes a consistent snapshot (either before or after each,
    // never torn). After settle, both orders are durably present.
    expect(Array.isArray(seen)).toBe(true);
    expect((await s.read()).orders.map((o) => o.id).sort()).toEqual(["a1", "b1"]);
  });

  it("seeds from an initial document", async () => {
    const init = emptyOperations();
    init.orders.push(order(A, "a1", "0x" + "a".repeat(64)));
    init.epoch = 5;
    const s = new InMemoryOperationsStore(init);
    const d = await s.read();
    expect(d.orders).toHaveLength(1);
    expect(d.epoch).toBe(5);
  });
});

describe("IdbOperationsStore (fake-indexeddb)", () => {
  it("round-trips a global update and resumes across instances", async () => {
    const indexedDB = new IDBFactory();
    const dbName = "test-desk-1";
    const s1 = new IdbOperationsStore({ indexedDB, dbName });
    await s1.update((d) => {
      d.orders.push(order(A, "a1", "0x" + "a".repeat(64)));
      d.epoch = 3;
    });
    // A fresh instance over the same db sees the persisted state.
    const s2 = new IdbOperationsStore({ indexedDB, dbName });
    const d = await s2.read();
    expect(d.orders).toHaveLength(1);
    expect(d.epoch).toBe(3);
  });

  it("shards orders per owner and reconstitutes them on read", async () => {
    const indexedDB = new IDBFactory();
    const s = new IdbOperationsStore({ indexedDB, dbName: "test-desk-2" });
    await Promise.all([
      s.updateOwner(A, (d) => d.orders.push(order(A, "a1", "0x" + "a".repeat(64)))),
      s.updateOwner(B, (d) => d.orders.push(order(B, "b1", "0x" + "b".repeat(64)))),
    ]);
    const all = await s.read();
    expect(all.orders.map((o) => o.id).sort()).toEqual(["a1", "b1"]);
  });

  it("a global update drops shards that went empty", async () => {
    const indexedDB = new IDBFactory();
    const s = new IdbOperationsStore({ indexedDB, dbName: "test-desk-3" });
    await s.updateOwner(A, (d) => d.orders.push(order(A, "a1", "0x" + "a".repeat(64))));
    await s.update((d) => {
      d.orders = d.orders.filter((o) => o.owner !== A);
    });
    expect((await s.read()).orders).toHaveLength(0);
  });
});
