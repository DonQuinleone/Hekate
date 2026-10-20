import type { PendingWrite } from "./take-outbox";

/**
 * Where the take log's outbox is kept: IndexedDB, so writes survive a reload, a crash or a
 * laptop closed mid-session; in memory where the browser offers no IndexedDB (a private
 * window in some browsers, tests).
 */
export interface OutboxStore {
  list(sessionId: string): Promise<PendingWrite[]>;
  add(write: PendingWrite): Promise<PendingWrite>;
  remove(seq: number): Promise<void>;
}

const DB = "hekate-take-log";
const STORE = "outbox";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function indexedStore(factory: IDBFactory): OutboxStore {
  let opened: Promise<IDBDatabase> | null = null;
  const db = () => {
    opened ??= new Promise((resolve, reject) => {
      const req = factory.open(DB, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: "seq", autoIncrement: true });
        store.createIndex("session", "sessionId");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return opened;
  };
  const store = async (mode: IDBTransactionMode) =>
    (await db()).transaction(STORE, mode).objectStore(STORE);
  return {
    async list(sessionId) {
      const all = await request(
        (await store("readonly")).index("session").getAll(IDBKeyRange.only(sessionId)),
      );
      return (all as PendingWrite[]).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    },
    async add(write) {
      const { seq: _seq, ...rest } = write;
      const seq = await request((await store("readwrite")).add(rest));
      return { ...write, seq: Number(seq) };
    },
    async remove(seq) {
      await request((await store("readwrite")).delete(seq));
    },
  };
}

export function memoryStore(): OutboxStore {
  const writes: PendingWrite[] = [];
  let next = 1;
  return {
    list: async (sessionId) => writes.filter((w) => w.sessionId === sessionId),
    add: async (write) => {
      const kept = { ...write, seq: next++ };
      writes.push(kept);
      return kept;
    },
    remove: async (seq) => {
      const i = writes.findIndex((w) => w.seq === seq);
      if (i >= 0) writes.splice(i, 1);
    },
  };
}

let shared: OutboxStore | null = null;

/** The outbox for this browser, made on first use. */
export function outboxStore(): OutboxStore {
  shared ??= typeof indexedDB === "undefined" ? memoryStore() : indexedStore(indexedDB);
  return shared;
}
