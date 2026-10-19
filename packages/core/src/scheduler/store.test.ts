import { describe, it, expect } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { IdbJobStore, InMemoryJobStore } from "./store.js";
import type { JobRecord, JobStore } from "./store.js";
import type { Operation } from "@farm/adapter-api";

const mkOp = (): Operation => ({
  kind: "chainCall", chainId: 57073,
  input: { chainId: 57073, to: { family: "evm", value: "0x0000000000000000000000000000000000000001" }, abi: [], method: "noop", args: [], clientId: "c" },
});
const rec = (id: string, status: JobRecord["status"]): JobRecord => ({ id, walletId: "A", op: mkOp(), status, attempts: 0, enqueuedAt: 1, updatedAt: 1 });

// The same contract runs against both stores so resume/idempotency logic is proven
// store-agnostic, with IndexedDB exercised via fake-indexeddb.
function contract(name: string, make: () => JobStore) {
  describe(name, () => {
    it("put/get/list(status)/delete/clear round-trip", async () => {
      const store = make();
      await store.put(rec("1", "pending"));
      await store.put(rec("2", "done"));
      await store.put(rec("3", "pending"));
      expect((await store.get("1"))?.status).toBe("pending");
      expect(await store.get("missing")).toBeUndefined();
      expect((await store.list("pending")).map((r) => r.id).sort()).toEqual(["1", "3"]);
      expect((await store.list()).length).toBe(3);
      await store.delete("1");
      expect(await store.get("1")).toBeUndefined();
      await store.clear();
      expect((await store.list()).length).toBe(0);
    });
  });
}

let dbSeq = 0;
contract("InMemoryJobStore", () => new InMemoryJobStore());
contract("IdbJobStore (fake-indexeddb)", () => new IdbJobStore({ indexedDB: new IDBFactory(), dbName: `t-${dbSeq++}` }));
