import { IndexedDBStore } from "#utils/storage.ts";

export type ReplicaSource = "remote" | "optimistic";

export interface ReplicaEntry<T> {
  key: string;
  value: T;
  source: ReplicaSource;
  version: number;
  operationId?: string;
  updatedAt: number;
}

export interface OptimisticReplicaOperation<T> {
  id: string;
  key: string;
  previous: ReplicaEntry<T> | null;
}

type ReplicaListener<T> = (entry: ReplicaEntry<T> | null) => void;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function operationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `optimistic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * A small, JSON-only local replica for ApiClient responses.
 *
 * The in-memory copy makes updates observable immediately. In browsers the
 * same entries are persisted to IndexedDB; server rendering and non-browser
 * tests retain only the in-memory behavior.
 */
export class ApiReplica {
  private readonly entries = new Map<string, ReplicaEntry<unknown>>();
  private readonly listeners = new Map<string, Set<ReplicaListener<unknown>>>();
  private readonly writeChains = new Map<string, Promise<unknown>>();
  private readonly store: IndexedDBStore<ReplicaEntry<unknown>> | null;

  constructor() {
    this.store =
      typeof indexedDB === "undefined"
        ? null
        : new IndexedDBStore<ReplicaEntry<unknown>>({
            dbName: "vektor-api-replica",
            storeName: "responses-v1",
            keyPath: "key",
          });
  }

  async get<T>(key: string): Promise<ReplicaEntry<T> | null> {
    const inMemory = this.entries.get(key) as ReplicaEntry<T> | undefined;
    if (inMemory) return clone(inMemory);

    if (!this.store) return null;

    try {
      const persisted = await this.store.get(key);
      if (!persisted) return null;
      this.entries.set(key, persisted);
      return clone(persisted as ReplicaEntry<T>);
    } catch {
      // A private-browsing quota/security error must not make API requests fail.
      return null;
    }
  }

  subscribe<T>(key: string, listener: ReplicaListener<T>): () => void {
    const listeners = this.listeners.get(key) ?? new Set<ReplicaListener<unknown>>();
    listeners.add(listener as ReplicaListener<unknown>);
    this.listeners.set(key, listeners);

    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(listener as ReplicaListener<unknown>);
      if (current.size === 0) this.listeners.delete(key);
    };
  }

  async replaceRemote<T>(key: string, value: T): Promise<ReplicaEntry<T>> {
    return await this.enqueue(key, async () => {
      const current = await this.get<T>(key);
      const entry: ReplicaEntry<T> = {
        key,
        value: clone(value),
        source: "remote",
        version: (current?.version ?? 0) + 1,
        updatedAt: Date.now(),
      };
      await this.write(entry);
      return clone(entry);
    });
  }

  /** Remove an entry after a canonical remote delete or alias change. */
  async removeRemote(key: string): Promise<void> {
    await this.enqueue(key, async () => {
      await this.remove(key);
    });
  }

  async applyOptimistic<T>(
    key: string,
    updater: (current: T | undefined) => T | undefined,
  ): Promise<OptimisticReplicaOperation<T>> {
    return await this.enqueue(key, async () => {
      const previous = await this.get<T>(key);
      const nextValue = updater(previous ? clone(previous.value) : undefined);
      const id = operationId();

      if (nextValue === undefined) {
        await this.remove(key);
      } else {
        await this.write({
          key,
          value: clone(nextValue),
          source: "optimistic",
          version: (previous?.version ?? 0) + 1,
          operationId: id,
          updatedAt: Date.now(),
        });
      }

      return {
        id,
        key,
        previous: previous ? clone(previous) : null,
      };
    });
  }

  /**
   * Restore a failed optimistic write only when no remote update (or newer
   * optimistic operation) has replaced it. This makes remote state canonical.
   */
  async rollback<T>(operation: OptimisticReplicaOperation<T>): Promise<void> {
    await this.enqueue(operation.key, async () => {
      const current = await this.get<T>(operation.key);
      if (current?.operationId !== operation.id) return;

      if (operation.previous) {
        await this.write({
          ...clone(operation.previous),
          version: current.version + 1,
          updatedAt: Date.now(),
        });
      } else {
        await this.remove(operation.key);
      }
    });
  }

  private async enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.writeChains.set(key, next);

    try {
      return await next;
    } finally {
      if (this.writeChains.get(key) === next) {
        this.writeChains.delete(key);
      }
    }
  }

  private async write<T>(entry: ReplicaEntry<T>): Promise<void> {
    const copy = clone(entry) as ReplicaEntry<unknown>;
    this.entries.set(entry.key, copy);
    this.notify(copy);

    if (!this.store) return;
    try {
      await this.store.put(copy);
    } catch {
      // Keep the page-local replica working even if IndexedDB is unavailable.
    }
  }

  private async remove(key: string): Promise<void> {
    this.entries.delete(key);
    this.notify(null, key);

    if (!this.store) return;
    try {
      await this.store.delete(key);
    } catch {
      // See write(): persistence is best-effort and never changes API semantics.
    }
  }

  private notify(entry: ReplicaEntry<unknown> | null, key = entry?.key): void {
    if (!key) return;
    for (const listener of this.listeners.get(key) ?? []) {
      listener(entry ? clone(entry) : null);
    }
  }
}
