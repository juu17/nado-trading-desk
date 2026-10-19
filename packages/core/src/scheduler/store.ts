// =============================================================================
// @farm/core · scheduler job store — the persisted queue behind the fleet
// scheduler. A JobSpec is SERIALIZABLE (a seam Operation + walletId + idempotency
// id), so a reload can resume: the browser uses the IndexedDB store, tests/node use
// the in-memory one. Idempotency is by job `id` (clientId-derived).
// =============================================================================
import type { Operation, WalletId } from "@farm/adapter-api";

export type JobStatus = "pending" | "running" | "done" | "failed";

export interface JobSpec {
  id: string;            // idempotency key (dedupe on enqueue + resume)
  walletId: WalletId;
  op: Operation;         // the serializable operation to execute
  templateId?: string;
  priority?: number;     // higher dispatches first (default 0)
  notBefore?: number;    // epoch ms; delays dispatch (per-wallet jitter / schedule)
}

export interface JobRecord extends JobSpec {
  status: JobStatus;
  attempts: number;
  enqueuedAt: number;
  updatedAt: number;
  error?: string;
  result?: unknown;
}

export interface JobStore {
  put(rec: JobRecord): Promise<void>;
  get(id: string): Promise<JobRecord | undefined>;
  list(status?: JobStatus): Promise<JobRecord[]>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryJobStore implements JobStore {
  private readonly map = new Map<string, JobRecord>();
  async put(rec: JobRecord): Promise<void> { this.map.set(rec.id, { ...rec }); }
  async get(id: string): Promise<JobRecord | undefined> { const r = this.map.get(id); return r ? { ...r } : undefined; }
  async list(status?: JobStatus): Promise<JobRecord[]> {
    const all = [...this.map.values()].map((r) => ({ ...r }));
    return status ? all.filter((r) => r.status === status) : all;
  }
  async delete(id: string): Promise<void> { this.map.delete(id); }
  async clear(): Promise<void> { this.map.clear(); }
}

const STORE = "jobs";

function reqToPromise<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** IndexedDB-backed store (browser). The resume/idempotency LOGIC is store-agnostic
 *  and covered by the in-memory tests; this impl is exercised with fake-indexeddb. */
export class IdbJobStore implements JobStore {
  private dbPromise?: Promise<IDBDatabase>;
  constructor(private readonly opts: { indexedDB?: IDBFactory; dbName?: string } = {}) {}

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      const idb = this.opts.indexedDB ?? indexedDB;
      const name = this.opts.dbName ?? "farm-scheduler";
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const open = idb.open(name, 1);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const os = db.createObjectStore(STORE, { keyPath: "id" });
            os.createIndex("status", "status", { unique: false });
          }
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
    }
    return this.dbPromise;
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.db();
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async put(rec: JobRecord): Promise<void> { await reqToPromise((await this.tx("readwrite")).put(rec)); }
  async get(id: string): Promise<JobRecord | undefined> {
    const r = await reqToPromise<JobRecord | undefined>((await this.tx("readonly")).get(id) as IDBRequest<JobRecord | undefined>);
    return r ?? undefined;
  }
  async list(status?: JobStatus): Promise<JobRecord[]> {
    const os = await this.tx("readonly");
    const src = status ? os.index("status").getAll(status) : os.getAll();
    return reqToPromise<JobRecord[]>(src as IDBRequest<JobRecord[]>);
  }
  async delete(id: string): Promise<void> { await reqToPromise((await this.tx("readwrite")).delete(id)); }
  async clear(): Promise<void> { await reqToPromise((await this.tx("readwrite")).clear()); }
}
