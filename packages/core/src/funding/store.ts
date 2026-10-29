// =============================================================================
// @farm/core · funding/store — the persisted OperationsStore behind the capacity
// engine. Two impls mirror BASE's scheduler/store.ts pattern: InMemoryOperationsStore
// (tests/node) and IdbOperationsStore (browser; the console uses the `nado-ika-custody`
// IndexedDB). Both implement the atomic serialized read-modify-write.
//
// 🎯 DENSITY (the whole point): `update` is NOT one global write-lock over all order
// writes. Orders are SHARDED PER OWNER; `updateOwner(owner, fn)` runs on a per-owner
// lane, so concurrent order writes for DIFFERENT wallets never serialize behind each
// other — N wallets dispatch N orders concurrently. A global `update` (operator
// stop/enable/recover, group edits) is exclusive w.r.t. every owner lane; same-owner
// updates serialize; different-owner updates run concurrently. This is single-process
// serialization (one tab / one node); cross-process IDB coordination is out of scope.
// =============================================================================
import {
  emptyOperations,
  refuse,
  type DeskOperations,
  type ExperimentCampaignSlot,
  type ProtectedOrder,
  type ShardedOperationsStore,
} from "./types.js";

// ---------------------------------------------------------------------------
// LaneLock — single-process serialization with a global lane + per-owner lanes.
// A global run waits for all in-flight lanes and blocks lanes that start after it;
// an owner run waits only for the global tail and its own owner's prior run.
// ---------------------------------------------------------------------------
class LaneLock {
  private globalTail: Promise<void> = Promise.resolve();
  private readonly ownerTails = new Map<string, Promise<void>>();

  global<T>(run: () => Promise<T>): Promise<T> {
    const waits = [this.globalTail, ...this.ownerTails.values()];
    const result = Promise.allSettled(waits).then(run);
    // Future owner lanes chain on this global run (which already awaited the current
    // owner tails); drop the now-subsumed owner tails so they re-queue behind it.
    this.ownerTails.clear();
    this.globalTail = result.then(noop, noop);
    return result;
  }

  owner<T>(key: string, run: () => Promise<T>): Promise<T> {
    const prior = this.ownerTails.get(key) ?? Promise.resolve();
    const result = Promise.allSettled([this.globalTail, prior]).then(run);
    this.ownerTails.set(key, result.then(noop, noop));
    return result;
  }
}
const noop = (): void => {};

// A desk document minus its orders (orders live in per-owner shards).
type GlobalDoc<C extends ExperimentCampaignSlot> = Omit<DeskOperations<C>, "orders">;

function splitShards<C extends ExperimentCampaignSlot>(
  doc: DeskOperations<C>,
): { global: GlobalDoc<C>; shards: Map<string, ProtectedOrder[]> } {
  const { orders, ...rest } = structuredClone(doc);
  const shards = new Map<string, ProtectedOrder[]>();
  for (const o of orders) bucket(shards, o.owner).push(o);
  return { global: rest as GlobalDoc<C>, shards };
}
function bucket(
  shards: Map<string, ProtectedOrder[]>,
  owner: string,
): ProtectedOrder[] {
  const key = owner.toLowerCase();
  let list = shards.get(key);
  if (!list) shards.set(key, (list = []));
  return list;
}

// ---------------------------------------------------------------------------
// In-memory store (tests / node). The RMW body is synchronous, so each lane run is
// atomic (no interleaving between read-shard and write-shard).
// ---------------------------------------------------------------------------
export class InMemoryOperationsStore<
  C extends ExperimentCampaignSlot = ExperimentCampaignSlot,
> implements ShardedOperationsStore<C>
{
  private global: GlobalDoc<C>;
  private readonly shards = new Map<string, ProtectedOrder[]>();
  private readonly lanes = new LaneLock();

  constructor(initial: DeskOperations<C> = emptyOperations<C>()) {
    const { global, shards } = splitShards(initial);
    this.global = global;
    for (const [owner, list] of shards) this.shards.set(owner, list);
  }

  private fullSnapshot(): DeskOperations<C> {
    const orders: ProtectedOrder[] = [];
    for (const list of this.shards.values()) for (const o of list) orders.push(o);
    return structuredClone({ ...this.global, orders } as DeskOperations<C>);
  }

  async read(): Promise<DeskOperations<C>> {
    return this.fullSnapshot();
  }

  update<T>(fn: (state: DeskOperations<C>) => T): Promise<T> {
    return this.lanes.global(async () => {
      const view = this.fullSnapshot();
      const result = fn(view);
      const { global, shards } = splitShards(view);
      this.global = global;
      this.shards.clear();
      for (const [owner, list] of shards) this.shards.set(owner, list);
      return structuredClone(result);
    });
  }

  updateOwner<T>(owner: string, fn: (state: DeskOperations<C>) => T): Promise<T> {
    const key = owner.toLowerCase();
    return this.lanes.owner(key, async () => {
      // Deep-clone ONLY this owner's orders (the mutable part). The global fields are
      // SHALLOW-shared, read-only — O(1), not an O(#wallets) deep clone of
      // groups/walletUsePlans on every single order write. The owner lane runs
      // exclusive w.r.t. the global lane, so `this.global` is stable here, and the
      // guards below reject any attempt to write it.
      const own = structuredClone(this.shards.get(key) ?? []);
      const view = { ...this.global, orders: own } as DeskOperations<C>;
      const result = fn(view);
      // The per-owner lane may only touch THIS owner's orders; writing another
      // owner's shard here would race that owner's lane.
      if (view.orders.some((o) => o.owner.toLowerCase() !== key))
        refuse("OPERATIONS_SHARD_ESCAPE");
      // Global-field writes belong on `update` (the global lane). Refuse a scalar
      // global write LOUDLY rather than silently dropping it (shallow-share means it
      // would otherwise vanish). Nested group/plan mutation is a documented no-go.
      assertNoScalarGlobalWrite(view, this.global);
      this.shards.set(key, structuredClone(view.orders));
      return structuredClone(result);
    });
  }
}

// A per-owner lane must not mutate the shared global scalars; catch the common misuse
// (flipping a flag / epoch / active plan) loudly. Nested groups/walletUsePlans/experiments
// mutation is not cheaply detectable and is a documented contract violation.
function assertNoScalarGlobalWrite<C extends ExperimentCampaignSlot>(
  view: DeskOperations<C>,
  global: GlobalDoc<C>,
): void {
  if (
    view.schema !== global.schema ||
    view.tradingStopped !== global.tradingStopped ||
    view.stopped !== global.stopped ||
    view.epoch !== global.epoch ||
    view.activeWalletUsePlanId !== global.activeWalletUsePlanId
  )
    refuse("OPERATIONS_GLOBAL_WRITE_ON_OWNER_LANE");
}

// ---------------------------------------------------------------------------
// IndexedDB store (browser). The global doc is one record; each owner's orders are
// one record. The JS-level lane (not the IDB tx) provides RMW atomicity within the
// process; a fresh instance over the same db resumes exactly.
//
// SCOPE (single-process; hardened further in Phase B/C): the global `update` spans
// several IDB transactions, so a crash mid-update can leave a torn global/shard state
// on resume; `read()` runs lock-free (a snapshot taken during a live write may mix
// pre/post-write shards), so observational reads should be quiescent w.r.t. dispatch.
// All shards share one object store, so IDB serializes overlapping readwrite txns —
// a per-write-density ceiling that only bites if IDB is on the dispatch hot path.
// ---------------------------------------------------------------------------
const STORE = "desk";
const GLOBAL_KEY = "__global__";
const ownerKey = (owner: string): string => `orders:${owner.toLowerCase()}`;

function reqToPromise<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class IdbOperationsStore<
  C extends ExperimentCampaignSlot = ExperimentCampaignSlot,
> implements ShardedOperationsStore<C>
{
  private dbPromise?: Promise<IDBDatabase>;
  private readonly lanes = new LaneLock();
  constructor(
    private readonly opts: { indexedDB?: IDBFactory; dbName?: string } = {},
  ) {}

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      const idb = this.opts.indexedDB ?? indexedDB;
      // Default to the console's custody IDB name (per project memory).
      const name = this.opts.dbName ?? "nado-ika-custody";
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const open = idb.open(name, 1);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
    }
    return this.dbPromise;
  }

  private async getRaw<V>(key: string): Promise<V | undefined> {
    const db = await this.db();
    const os = db.transaction(STORE, "readonly").objectStore(STORE);
    const v = await reqToPromise<V | undefined>(
      os.get(key) as IDBRequest<V | undefined>,
    );
    return v ?? undefined;
  }

  private async putRaw(key: string, value: unknown): Promise<void> {
    const db = await this.db();
    const os = db.transaction(STORE, "readwrite").objectStore(STORE);
    await reqToPromise(os.put(value, key));
  }

  private async readGlobal(): Promise<GlobalDoc<C>> {
    const g = await this.getRaw<GlobalDoc<C>>(GLOBAL_KEY);
    if (g) return g;
    const { orders: _orders, ...rest } = emptyOperations<C>();
    return rest as GlobalDoc<C>;
  }

  private async readShard(owner: string): Promise<ProtectedOrder[]> {
    return (await this.getRaw<ProtectedOrder[]>(ownerKey(owner))) ?? [];
  }

  private async listOwnerKeys(): Promise<string[]> {
    const db = await this.db();
    const os = db.transaction(STORE, "readonly").objectStore(STORE);
    const keys = await reqToPromise<IDBValidKey[]>(os.getAllKeys());
    return keys
      .map(String)
      .filter((k) => k.startsWith("orders:"));
  }

  async read(): Promise<DeskOperations<C>> {
    const global = await this.readGlobal();
    const keys = await this.listOwnerKeys();
    const orders: ProtectedOrder[] = [];
    for (const k of keys) {
      const list = (await this.getRaw<ProtectedOrder[]>(k)) ?? [];
      for (const o of list) orders.push(o);
    }
    return { ...global, orders } as DeskOperations<C>;
  }

  update<T>(fn: (state: DeskOperations<C>) => T): Promise<T> {
    return this.lanes.global(async () => {
      const view = await this.read();
      const result = fn(view);
      const { global, shards } = splitShards(view);
      await this.putRaw(GLOBAL_KEY, global);
      // Rewrite every owner shard, and clear shards that went empty.
      const live = new Set<string>();
      for (const [owner, list] of shards) {
        await this.putRaw(ownerKey(owner), list);
        live.add(ownerKey(owner));
      }
      for (const k of await this.listOwnerKeys())
        if (!live.has(k)) await this.deleteRaw(k);
      return structuredClone(result);
    });
  }

  updateOwner<T>(owner: string, fn: (state: DeskOperations<C>) => T): Promise<T> {
    const key = owner.toLowerCase();
    return this.lanes.owner(key, async () => {
      const global = await this.readGlobal();
      const own = await this.readShard(key);
      const view = { ...global, orders: own } as DeskOperations<C>;
      const result = fn(view);
      if (view.orders.some((o) => o.owner.toLowerCase() !== key))
        refuse("OPERATIONS_SHARD_ESCAPE");
      assertNoScalarGlobalWrite(view, global);
      await this.putRaw(ownerKey(key), view.orders);
      return structuredClone(result);
    });
  }

  private async deleteRaw(key: string): Promise<void> {
    const db = await this.db();
    const os = db.transaction(STORE, "readwrite").objectStore(STORE);
    await reqToPromise(os.delete(key));
  }
}
