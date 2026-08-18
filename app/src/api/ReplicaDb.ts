import { IndexedDBDatabase } from "#utils/storage.ts";

/**
 * Object stores mirroring the space schema in `#db/schema/space.ts`.
 *
 * The client cache holds rows, not API responses. A row written once is the
 * single copy every view reads, so a mutation updates one record instead of
 * every cached response shape that happened to contain the entity.
 *
 * `collection` is the one store with no server counterpart: it records which
 * rows a list endpoint returned, in the order it returned them. Lists are read
 * *through* it, which is what makes a row the server no longer returns
 * disappear from a list without having to be found and deleted.
 */
export const replicaStores = {
  space: "space",
  document: "document",
  property: "property",
  category: "category",
  comment: "comment",
  extension: "extension",
  collection: "collection",
} as const;

export type ReplicaStore = (typeof replicaStores)[keyof typeof replicaStores];

/** Primary keys, and the indexes the client reads by. */
const REPLICA_SCHEMA: Array<{
  name: ReplicaStore;
  keyPath: string[];
  indexes?: Array<{ name: string; keyPath: string[] }>;
}> = [
  { name: replicaStores.space, keyPath: ["spaceId", "id"] },
  {
    name: replicaStores.document,
    keyPath: ["spaceId", "id"],
    indexes: [{ name: "by_slug", keyPath: ["spaceId", "slug"] }],
  },
  {
    name: replicaStores.property,
    keyPath: ["spaceId", "documentId", "key"],
    indexes: [{ name: "by_document", keyPath: ["spaceId", "documentId"] }],
  },
  { name: replicaStores.category, keyPath: ["spaceId", "id"] },
  {
    name: replicaStores.comment,
    keyPath: ["spaceId", "id"],
    // Keyed by the resource column the server sends, not by a `documentId` the
    // wire never carries — an index key a record lacks silently excludes it.
    indexes: [{ name: "by_resource", keyPath: ["spaceId", "resourceId"] }],
  },
  { name: replicaStores.extension, keyPath: ["spaceId", "id"] },
  { name: replicaStores.collection, keyPath: ["spaceId", "name"] },
];

const SCHEMA_BY_STORE = new Map(REPLICA_SCHEMA.map((store) => [store.name, store]));

const DATABASE_PREFIX = "vektor-replica-";

export interface ReplicaRecord {
  /** Rows are table rows: which columns follow is the store's business. */
  [column: string]: unknown;
  spaceId: string;
  /**
   * Set while an unconfirmed local write owns this row, and cleared when a
   * server response replaces it. A rollback that finds a different value here
   * has been superseded and does nothing.
   */
  operationId?: string;
}

export type ReplicaWrite<T extends ReplicaRecord = ReplicaRecord> =
  | { store: ReplicaStore; put: T }
  | { store: ReplicaStore; remove: IDBValidKey[] };

/**
 * A write set, or a builder for one. Pass a builder when the writes depend on
 * rows already in the cache: it runs inside the mutation's exclusive section,
 * so what it reads cannot change before what it returns is written.
 */
export type ReplicaWrites = ReplicaWrite[] | (() => Promise<ReplicaWrite[]>);

export interface ReplicaOperation {
  id: string;
  /** Rows as they were before the optimistic write, for an exact restore. */
  previous: Array<{
    store: ReplicaStore;
    key: IDBValidKey[];
    record: ReplicaRecord | null;
  }>;
}

type ReplicaListener = () => void;

interface Subscription {
  stores: Set<ReplicaStore>;
  spaceId: string | null;
  listener: ReplicaListener;
}

/** Backends differ only in where rows live; the semantics above are shared. */
interface ReplicaBackend {
  get(store: ReplicaStore, key: IDBValidKey[]): Promise<ReplicaRecord | null>;
  getSpace(store: ReplicaStore, spaceId: string): Promise<ReplicaRecord[]>;
  getByIndex(
    store: ReplicaStore,
    index: string,
    key: IDBValidKey[],
  ): Promise<ReplicaRecord[]>;
  write(writes: ReplicaWrite[]): Promise<void>;
  close(): void;
}

function keyOf(store: ReplicaStore, record: ReplicaRecord): IDBValidKey[] {
  const schema = SCHEMA_BY_STORE.get(store);
  if (!schema) throw new Error(`Unknown replica store: ${store}`);
  return schema.keyPath.map((part) => record[part] as IDBValidKey);
}

/**
 * Every key in a space. An array sorts above every string in IndexedDB's key
 * ordering, so `[spaceId, []]` is an exclusive upper bound for the space.
 */
function spaceRange(spaceId: string): IDBKeyRange {
  return IDBKeyRange.bound([spaceId], [spaceId, []]);
}

function newOperationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `optimistic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

class IndexedDBReplicaBackend implements ReplicaBackend {
  private readonly database: IndexedDBDatabase;

  constructor(scope: string) {
    this.database = new IndexedDBDatabase({
      name: `${DATABASE_PREFIX}${scope}`,
      version: 2,
      stores: REPLICA_SCHEMA,
    });
  }

  async get(store: ReplicaStore, key: IDBValidKey[]): Promise<ReplicaRecord | null> {
    return await this.database.get<ReplicaRecord>(store, key);
  }

  async getSpace(store: ReplicaStore, spaceId: string): Promise<ReplicaRecord[]> {
    return await this.database.getAll<ReplicaRecord>(store, spaceRange(spaceId));
  }

  async getByIndex(
    store: ReplicaStore,
    index: string,
    key: IDBValidKey[],
  ): Promise<ReplicaRecord[]> {
    return await this.database.getAllByIndex<ReplicaRecord>(store, index, key);
  }

  async write(writes: ReplicaWrite[]): Promise<void> {
    await this.database.write(
      writes.map((write) =>
        "put" in write
          ? { store: write.store, put: write.put }
          : { store: write.store, delete: write.remove },
      ),
    );
  }

  close(): void {
    this.database.close();
  }
}

/** Used by server rendering and tests, where IndexedDB does not exist. */
class MemoryReplicaBackend implements ReplicaBackend {
  private readonly rows = new Map<ReplicaStore, Map<string, ReplicaRecord>>();

  private store(store: ReplicaStore): Map<string, ReplicaRecord> {
    const existing = this.rows.get(store);
    if (existing) return existing;
    const created = new Map<string, ReplicaRecord>();
    this.rows.set(store, created);
    return created;
  }

  async get(store: ReplicaStore, key: IDBValidKey[]): Promise<ReplicaRecord | null> {
    const record = this.store(store).get(JSON.stringify(key));
    return record ? structuredClone(record) : null;
  }

  async getSpace(store: ReplicaStore, spaceId: string): Promise<ReplicaRecord[]> {
    return [...this.store(store).values()]
      .filter((record) => record.spaceId === spaceId)
      .map((record) => structuredClone(record));
  }

  async getByIndex(
    store: ReplicaStore,
    index: string,
    key: IDBValidKey[],
  ): Promise<ReplicaRecord[]> {
    const keyPath = SCHEMA_BY_STORE.get(store)?.indexes?.find(
      (candidate) => candidate.name === index,
    )?.keyPath;
    if (!keyPath) return [];

    return [...this.store(store).values()]
      .filter((record) =>
        keyPath.every((part, position) => record[part] === key[position]),
      )
      .map((record) => structuredClone(record));
  }

  async write(writes: ReplicaWrite[]): Promise<void> {
    for (const write of writes) {
      if ("put" in write) {
        this.store(write.store).set(
          JSON.stringify(keyOf(write.store, write.put)),
          structuredClone(write.put),
        );
      } else {
        this.store(write.store).delete(JSON.stringify(write.remove));
      }
    }
  }

  close(): void {
    this.rows.clear();
  }
}

/**
 * The row store behind every cached read.
 *
 * Callers address rows by primary key; `ReplicaCache` turns them back into the
 * shapes the UI wants. Persistence is best-effort throughout — a private-mode
 * quota error must never turn into a failed API call — so every operation
 * swallows storage errors and degrades to "nothing cached".
 */
export class ReplicaDb {
  private backend: ReplicaBackend | null = null;
  private scope: string | null = null;
  private readonly subscriptions = new Set<Subscription>();
  /** Subscriptions a write has touched, awaiting the coalesced notification. */
  private readonly pending = new Set<Subscription>();
  private notificationScheduled = false;
  private writeChain: Promise<unknown> = Promise.resolve();

  /**
   * Bind the cache to a browser identity. A scope is required: sessions change
   * users while IndexedDB survives logout, so unscoped data is never persisted.
   */
  setScope(scope: string | null | undefined): void {
    const next = scope?.trim() || null;
    if (next === this.scope) return;

    this.backend?.close();
    this.scope = next;
    this.backend = next === null ? null : this.createBackend(next);
    if (next !== null) void purgeForeignDatabases(next);
    this.notify(new Set(Object.values(replicaStores)), null);
  }

  private createBackend(scope: string): ReplicaBackend {
    return typeof indexedDB === "undefined"
      ? new MemoryReplicaBackend()
      : new IndexedDBReplicaBackend(scope);
  }

  async get<T extends ReplicaRecord>(
    store: ReplicaStore,
    key: IDBValidKey[],
  ): Promise<T | null> {
    if (!this.backend) return null;
    try {
      return (await this.backend.get(store, key)) as T | null;
    } catch {
      return null;
    }
  }

  async getSpace<T extends ReplicaRecord>(
    store: ReplicaStore,
    spaceId: string,
  ): Promise<T[]> {
    if (!this.backend) return [];
    try {
      return (await this.backend.getSpace(store, spaceId)) as T[];
    } catch {
      return [];
    }
  }

  async getByIndex<T extends ReplicaRecord>(
    store: ReplicaStore,
    index: string,
    key: IDBValidKey[],
  ): Promise<T[]> {
    if (!this.backend) return [];
    try {
      return (await this.backend.getByIndex(store, index, key)) as T[];
    } catch {
      return [];
    }
  }

  /** Write rows the server has confirmed, clearing any optimistic ownership. */
  async writeRemote(writes: ReplicaWrites): Promise<void> {
    if (!this.backend) return;

    await this.runExclusive(async () => {
      const resolved = await resolveWrites(writes);
      await this.flush(
        resolved.map((write) =>
          "put" in write
            ? { store: write.store, put: { ...write.put, operationId: undefined } }
            : write,
        ),
      );
    });
  }

  /**
   * Write rows that a request has not confirmed yet, returning the handle that
   * `rollback` needs to undo exactly these rows and nothing newer.
   */
  async writeOptimistic(writes: ReplicaWrites): Promise<ReplicaOperation | null> {
    if (!this.backend) return null;

    return await this.runExclusive(async () => {
      const resolved = await resolveWrites(writes);
      if (resolved.length === 0) return null;

      const id = newOperationId();
      const operation: ReplicaOperation = { id, previous: [] };

      for (const write of resolved) {
        const key = "put" in write ? keyOf(write.store, write.put) : write.remove;
        operation.previous.push({
          store: write.store,
          key,
          record: await this.get(write.store, key),
        });
      }

      await this.flush(
        resolved.map((write) =>
          "put" in write
            ? { store: write.store, put: { ...write.put, operationId: id } }
            : write,
        ),
      );
      return operation;
    });
  }

  /**
   * Restore the rows an optimistic write replaced — but only those it still
   * owns. A server response that landed in the meantime is canonical and stays.
   */
  async rollback(operation: ReplicaOperation | null): Promise<void> {
    if (!operation || !this.backend) return;

    await this.runExclusive(async () => {
      const writes: ReplicaWrite[] = [];
      for (const { store, key, record } of operation.previous) {
        const current = await this.get(store, key);
        if (current?.operationId !== operation.id) continue;
        writes.push(record ? { store, put: record } : { store, remove: key });
      }
      await this.flush(writes);
    });
  }

  /**
   * Re-run `read` whenever any of `stores` changes in `spaceId` (or in any
   * space when it is null). The callback does not fire on subscription;
   * callers hydrate with a direct read first.
   *
   * One read runs at a time. `read` answers a whole query — a space's document
   * list, say — so writes landing while one is in flight would otherwise each
   * start their own pass over the same rows, and deliver the same answer
   * several times over. They collapse into a single re-read instead.
   */
  subscribe<T>(
    stores: ReplicaStore[],
    spaceId: string | null,
    read: () => Promise<T>,
    callback: (value: T) => void,
  ): () => void {
    let disposed = false;
    let reading = false;
    let missedWrite = false;

    const runRead = () => {
      if (reading) {
        missedWrite = true;
        return;
      }
      reading = true;
      void read()
        .then((value) => {
          if (!disposed) callback(value);
        })
        .catch(() => undefined)
        .finally(() => {
          reading = false;
          if (!missedWrite || disposed) return;
          missedWrite = false;
          runRead();
        });
    };

    const subscription: Subscription = {
      stores: new Set(stores),
      spaceId,
      listener: runRead,
    };

    this.subscriptions.add(subscription);
    return () => {
      disposed = true;
      this.subscriptions.delete(subscription);
      this.pending.delete(subscription);
    };
  }

  /**
   * Mutations run one at a time because they read-modify-write rows — merging
   * a partial document into a stored one, appending an id to a collection —
   * and two interleaved mutations would otherwise lose one of the updates.
   */
  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeChain.catch(() => undefined).then(operation);
    this.writeChain = run;
    return await run;
  }

  private async flush(writes: ReplicaWrite[]): Promise<void> {
    if (!this.backend || writes.length === 0) return;

    try {
      await this.backend.write(writes);
    } catch {
      // Storage is best-effort; a failed write must not fail the API call.
      return;
    }

    const stores = new Set(writes.map((write) => write.store));
    const spaceIds = new Set(
      writes.map((write) =>
        "put" in write ? write.put.spaceId : String(write.remove[0]),
      ),
    );
    for (const spaceId of spaceIds) this.notify(stores, spaceId);
  }

  private notify(stores: Set<ReplicaStore>, spaceId: string | null): void {
    for (const subscription of this.subscriptions) {
      if (subscription.spaceId !== null && spaceId !== null) {
        if (subscription.spaceId !== spaceId) continue;
      }
      for (const store of stores) {
        if (!subscription.stores.has(store)) continue;
        this.pending.add(subscription);
        break;
      }
    }

    // A single flush can touch several stores one subscription watches, and a
    // response can produce several flushes. Each notification re-reads the
    // subscribed query in full and re-renders whatever draws it, so matched
    // subscriptions are collected and fired once, after the writes settle.
    if (this.pending.size > 0 && !this.notificationScheduled) {
      this.notificationScheduled = true;
      queueMicrotask(() => this.drainNotifications());
    }
  }

  private drainNotifications(): void {
    this.notificationScheduled = false;
    const due = [...this.pending];
    this.pending.clear();
    for (const subscription of due) {
      if (this.subscriptions.has(subscription)) subscription.listener();
    }
  }
}

async function resolveWrites(writes: ReplicaWrites): Promise<ReplicaWrite[]> {
  return typeof writes === "function" ? await writes() : writes;
}

/**
 * Drop databases belonging to other identities. IndexedDB outlives a session,
 * so without this every user who ever signed in on this browser keeps a full
 * copy of their space.
 */
async function purgeForeignDatabases(scope: string): Promise<void> {
  if (typeof indexedDB === "undefined" || !("databases" in indexedDB)) return;

  try {
    const current = `${DATABASE_PREFIX}${scope}`;
    for (const { name } of await indexedDB.databases()) {
      if (!name?.startsWith(DATABASE_PREFIX) || name === current) continue;
      indexedDB.deleteDatabase(name);
    }
  } catch {
    // Nothing here is required for correctness.
  }
}
