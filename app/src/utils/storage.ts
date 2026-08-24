export interface IndexConfig {
  name: string;
  keyPath: string | string[];
  unique?: boolean;
}

export interface StoreConfig {
  dbName: string;
  storeName: string;
  keyPath: string | string[];
  indexes?: IndexConfig[];
  version?: number;
}

export interface DatabaseStoreConfig {
  name: string;
  keyPath: string | string[];
  indexes?: IndexConfig[];
}

export interface DatabaseConfig {
  name: string;
  stores: DatabaseStoreConfig[];
}

/** `a` is the live key path, which is null on a store with no in-line key. */
function sameKeyPath(a: string | string[] | null, b: string | string[]): boolean {
  if (a === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((part, i) => part === b[i]);
  }
  return a === b;
}

/** Whether a live index still is what the schema asks for. */
function matchesDeclaration(live: IDBIndex, declared: IndexConfig): boolean {
  return (
    sameKeyPath(live.keyPath, declared.keyPath) &&
    live.unique === (declared.unique ?? false)
  );
}

/**
 * Whether the database already looks the way the stores declare.
 *
 * Read-only, and deliberately the same comparison the upgrade acts on: this
 * decides whether an upgrade is needed at all, so anything it calls equal is
 * something the upgrade would have left alone.
 */
function schemaIsCurrent(db: IDBDatabase, stores: DatabaseStoreConfig[]): boolean {
  const declaredStores = new Set(stores.map((store) => store.name));
  if (Array.from(db.objectStoreNames).some((name) => !declaredStores.has(name))) {
    return false;
  }
  if (stores.some((store) => !db.objectStoreNames.contains(store.name))) return false;
  if (stores.length === 0) return true;

  const transaction = db.transaction(Array.from(declaredStores), "readonly");
  try {
    return stores.every((store) => {
      const objectStore = transaction.objectStore(store.name);
      if (!sameKeyPath(objectStore.keyPath, store.keyPath)) return false;

      const declared = store.indexes ?? [];
      const live = Array.from(objectStore.indexNames);
      if (live.length !== declared.length) return false;
      return declared.every(
        (index) =>
          objectStore.indexNames.contains(index.name) &&
          matchesDeclaration(objectStore.index(index.name), index),
      );
    });
  } finally {
    transaction.abort();
  }
}

export interface DatabaseWrite {
  store: string;
  /** Record to insert or replace. Mutually exclusive with `delete`. */
  put?: object;
  /** Key of the record to remove. Mutually exclusive with `put`. */
  delete?: IDBValidKey;
}

/**
 * A database whose stores are declared up front.
 *
 * `IndexedDBStore` owns a single store and discovers it at runtime, which is
 * what a feature storing one kind of blob needs. This one exists for the
 * opposite case: a fixed set of related stores that has to be written in one
 * transaction, so a multi-record update cannot land half-applied.
 */
export class IndexedDBDatabase {
  private db: IDBDatabase | null = null;
  private openPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly config: DatabaseConfig) {}

  /**
   * Bring one store in line with its declaration.
   *
   * Neither a store's key path nor an index can be altered in place, so both
   * are rebuilt. Rebuilding a store drops its rows, which is the trade this
   * cache accepts: a wrongly keyed row is unreachable anyway, and the next read
   * refetches. Indexes cost nothing to rebuild — they repopulate from the rows
   * already there.
   */
  private syncStore(
    db: IDBDatabase,
    transaction: IDBTransaction,
    store: DatabaseStoreConfig,
  ): void {
    if (db.objectStoreNames.contains(store.name)) {
      if (!sameKeyPath(transaction.objectStore(store.name).keyPath, store.keyPath)) {
        db.deleteObjectStore(store.name);
      }
    }

    const objectStore = db.objectStoreNames.contains(store.name)
      ? transaction.objectStore(store.name)
      : db.createObjectStore(store.name, { keyPath: store.keyPath });

    const declared = store.indexes ?? [];
    for (const name of Array.from(objectStore.indexNames)) {
      const index = declared.find((candidate) => candidate.name === name);
      if (!index || !matchesDeclaration(objectStore.index(name), index)) {
        objectStore.deleteIndex(name);
      }
    }
    for (const index of declared) {
      if (objectStore.indexNames.contains(index.name)) continue;
      objectStore.createIndex(index.name, index.keyPath, {
        unique: index.unique || false,
      });
    }
  }

  private openAt(version?: number): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.config.name, version);

      request.onupgradeneeded = () => {
        const transaction = request.transaction;
        // Cannot happen during an upgrade; throwing beats migrating nothing and
        // reporting success, which is the failure this whole path exists to stop.
        if (!transaction) throw new Error("Upgrade started without a transaction");
        const db = request.result;
        for (const name of Array.from(db.objectStoreNames)) {
          if (!this.config.stores.some((store) => store.name === name)) {
            db.deleteObjectStore(name);
          }
        }
        for (const store of this.config.stores) {
          this.syncStore(db, transaction, store);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      // Another tab is holding the old version open. It closes on
      // `onversionchange` below, so this resolves on its own.
      request.onblocked = () => {};
    });
  }

  private open(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    if (this.openPromise) return this.openPromise;

    this.openPromise = (async () => {
      // The declaration is the version. Opening without one reveals what is
      // actually stored; a bump only happens when that has drifted, so editing
      // the schema is all it takes for the change to land — there is no number
      // to remember, and nothing to forget.
      let db = await this.openAt();
      if (!schemaIsCurrent(db, this.config.stores)) {
        const next = db.version + 1;
        db.close();
        db = await this.openAt(next);
      }

      this.db = db;
      // Another tab upgrading or deleting this database closes our handle;
      // drop it so the next call reopens instead of throwing.
      db.onclose = () => {
        this.db = null;
      };
      db.onversionchange = () => {
        db.close();
        this.db = null;
      };
      return db;
    })().finally(() => {
      this.openPromise = null;
    });

    return this.openPromise;
  }

  private async request<R>(
    storeName: string,
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest<R>,
  ): Promise<R> {
    const db = await this.open();

    return new Promise((resolve, reject) => {
      const request = op(db.transaction([storeName], mode).objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async get<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
    return (
      ((await this.request<T>(storeName, "readonly", (store) => store.get(key))) as
        | T
        | undefined) ?? null
    );
  }

  async getAll<T>(storeName: string, query?: IDBKeyRange): Promise<T[]> {
    return (
      (await this.request<T[]>(storeName, "readonly", (store) => store.getAll(query))) ??
      []
    );
  }

  async getAllByIndex<T>(
    storeName: string,
    indexName: string,
    query?: IDBValidKey | IDBKeyRange,
  ): Promise<T[]> {
    return (
      (await this.request<T[]>(storeName, "readonly", (store) =>
        store.index(indexName).getAll(query),
      )) ?? []
    );
  }

  /** Apply every write in a single transaction, or none of them. */
  async write(writes: DatabaseWrite[]): Promise<void> {
    if (writes.length === 0) return;
    const db = await this.open();
    const storeNames = [...new Set(writes.map((write) => write.store))];

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeNames, "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);

      for (const write of writes) {
        const store = transaction.objectStore(write.store);
        if (write.put !== undefined) store.put(write.put);
        else if (write.delete !== undefined) store.delete(write.delete);
      }
    });
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

export class IndexedDBStore<T extends object> {
  private db: IDBDatabase | null = null;
  private config: StoreConfig;
  private initPromise: Promise<void> | null = null;

  constructor(config: StoreConfig) {
    this.config = config;
  }

  /**
   * Initialize the database connection
   */
  async init(): Promise<void> {
    if (this.db) {
      if (this.db.objectStoreNames.contains(this.config.storeName)) {
        return;
      }
      this.db.close();
      this.db = null;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private createStore(db: IDBDatabase): void {
    const store = db.createObjectStore(this.config.storeName, {
      keyPath: this.config.keyPath,
    });
    if (this.config.indexes) {
      for (const index of this.config.indexes) {
        store.createIndex(index.name, index.keyPath, {
          unique: index.unique || false,
        });
      }
    }
  }

  private async doInit(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Open without a version first to detect current state
      const detectRequest = indexedDB.open(this.config.dbName);

      detectRequest.onupgradeneeded = (event) => {
        // DB is brand new — create the store in this upgrade transaction
        this.createStore((event.target as IDBOpenDBRequest).result);
      };

      detectRequest.onsuccess = () => {
        const db = detectRequest.result;

        if (db.objectStoreNames.contains(this.config.storeName)) {
          // Store exists — use this connection directly
          this.db = db;
          this.initPromise = null;
          resolve();
          return;
        }

        // DB exists but store is missing (e.g. from a failed previous init)
        // Bump the version to trigger onupgradeneeded
        const bumpVersion = db.version + 1;
        db.close();

        const upgradeRequest = indexedDB.open(this.config.dbName, bumpVersion);

        upgradeRequest.onupgradeneeded = (event) => {
          this.createStore((event.target as IDBOpenDBRequest).result);
        };

        upgradeRequest.onsuccess = () => {
          this.db = upgradeRequest.result;
          this.initPromise = null;
          resolve();
        };

        upgradeRequest.onerror = () => reject(upgradeRequest.error);
      };

      detectRequest.onerror = () => reject(detectRequest.error);
    });
  }

  /**
   * Open a transaction and return its object store
   */
  private async openStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    await this.init();

    if (!this.db) throw new Error("Database not initialized");

    const transaction = this.db.transaction([this.config.storeName], mode);
    return transaction.objectStore(this.config.storeName);
  }

  /**
   * Run a single request against the store and resolve with its result
   */
  private async request<R>(
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest<R>,
  ): Promise<R> {
    const store = await this.openStore(mode);

    return new Promise((resolve, reject) => {
      const request = op(store);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get a single item by key
   */
  async get(key: IDBValidKey): Promise<T | null> {
    return (await this.request("readonly", (store) => store.get(key))) || null;
  }

  /**
   * Put (insert or update) an item
   */
  async put(value: T): Promise<void> {
    await this.request("readwrite", (store) => store.put(value));
  }

  /**
   * Delete an item by key
   */
  async delete(key: IDBValidKey): Promise<void> {
    await this.request("readwrite", (store) => store.delete(key));
  }

  /**
   * Get all items
   */
  async getAll(): Promise<T[]> {
    return (await this.request("readonly", (store) => store.getAll())) || [];
  }

  /**
   * Clear all items
   */
  async clear(): Promise<void> {
    await this.request("readwrite", (store) => store.clear());
  }

  /**
   * Get items by index range
   */
  async getByIndex(
    indexName: string,
    query?: IDBValidKey | IDBKeyRange,
    direction: IDBCursorDirection = "next",
    limit?: number,
  ): Promise<T[]> {
    const store = await this.openStore("readonly");

    return new Promise((resolve, reject) => {
      const index = store.index(indexName);

      const results: T[] = [];

      const request = index.openCursor(query || null, direction);

      request.onsuccess = () => {
        const cursor = request.result;

        if (cursor && (!limit || results.length < limit)) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
