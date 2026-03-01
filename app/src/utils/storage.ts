export interface IndexConfig {
  name: string;
  keyPath: string | string[];
  unique?: boolean;
}

export interface StoreConfig<T> {
  dbName: string;
  storeName: string;
  keyPath: string | string[];
  indexes?: IndexConfig[];
  version?: number;
}

export class IndexedDBStore<T extends Record<string, any>> {
  private db: IDBDatabase | null = null;
  private config: StoreConfig<T>;
  private initPromise: Promise<void> | null = null;

  constructor(config: StoreConfig<T>) {
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
   * Get a single item by key
   */
  async get(key: IDBValidKey): Promise<T | null> {
    await this.init();

    if (!this.db) throw new Error("Database not initialized");

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readonly");
      const store = transaction.objectStore(this.config.storeName);
      const request = store.get(key);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Put (insert or update) an item
   */
  async put(value: T): Promise<void> {
    await this.init();

    if (!this.db) throw new Error("Database not initialized");

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readwrite");
      const store = transaction.objectStore(this.config.storeName);
      const request = store.put(value);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete an item by key
   */
  async delete(key: IDBValidKey): Promise<void> {
    await this.init();

    if (!this.db) throw new Error("Database not initialized");

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readwrite");
      const store = transaction.objectStore(this.config.storeName);
      const request = store.delete(key);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all items
   */
  async getAll(): Promise<T[]> {
    await this.init();

    if (!this.db) throw new Error("Database not initialized");

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readonly");
      const store = transaction.objectStore(this.config.storeName);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all items
   */
  async clear(): Promise<void> {
    await this.init();

    if (!this.db) throw new Error("Database not initialized");

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readwrite");
      const store = transaction.objectStore(this.config.storeName);
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Count total items
   */
  async count(): Promise<number> {
    await this.init();

    if (!this.db) throw new Error("Database not initialized");

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readonly");
      const store = transaction.objectStore(this.config.storeName);
      const request = store.count();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Query items using a cursor with optional index
   */
  async query<R = T>(callback: (store: IDBObjectStore) => IDBRequest<R>): Promise<R> {
    await this.init();

    if (!this.db) throw new Error("Database not initialized");

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readonly");
      const store = transaction.objectStore(this.config.storeName);
      const request = callback(store);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Query items with a cursor for iteration
   */
  async queryCursor(
    callback: (cursor: IDBCursorWithValue) => void,
    indexName?: string,
    direction: IDBCursorDirection = "next",
  ): Promise<void> {
    await this.init();

    if (!this.db) throw new Error("Database not initialized");

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readonly");
      const store = transaction.objectStore(this.config.storeName);

      const source = indexName ? store.index(indexName) : store;
      const request = source.openCursor(null, direction);

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          callback(cursor);
          cursor.continue();
        } else {
          resolve();
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Execute a custom transaction
   */
  async transaction<R>(
    mode: IDBTransactionMode,
    callback: (store: IDBObjectStore) => Promise<R>,
  ): Promise<R> {
    await this.init();

    if (!this.db) throw new Error("Database not initialized");

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], mode);
      const store = transaction.objectStore(this.config.storeName);

      transaction.oncomplete = () => {
        // Transaction completed
      };

      transaction.onerror = () => reject(transaction.error);

      callback(store).then(resolve).catch(reject);
    });
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
    await this.init();

    if (!this.db) throw new Error("Database not initialized");

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readonly");
      const store = transaction.objectStore(this.config.storeName);
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
   * Batch put multiple items
   */
  async putBatch(items: T[]): Promise<void> {
    await this.init();

    if (!this.db) throw new Error("Database not initialized");

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.config.storeName], "readwrite");
      const store = transaction.objectStore(this.config.storeName);

      let completed = 0;
      const errors: Error[] = [];

      for (const item of items) {
        const request = store.put(item);

        request.onsuccess = () => {
          completed++;
          if (completed === items.length) {
            if (errors.length > 0) {
              reject(errors[0]);
            } else {
              resolve();
            }
          }
        };

        request.onerror = () => {
          errors.push(new Error(`Failed to put item: ${request.error}`));
          completed++;
          if (completed === items.length) {
            reject(errors[0]);
          }
        };
      }
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
