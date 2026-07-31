/**
 * The query cache, with no framework in it.
 *
 * Entries, key hashing, freshness, in-flight de-duplication, invalidation and
 * subscriber notification. A framework binding sits on top and turns
 * `observers` into whatever that framework calls reactive state — see
 * `query.ts`.
 *
 * Keys arrive already resolved to plain values. Unwrapping a framework's
 * reactive boxes is the binding's job, which is what keeps this file — and so
 * the server's document path — free of one.
 */

export type QueryKey = readonly unknown[];
export type QueryDataUpdater<T> = T | ((old: T | undefined) => T | undefined);

export interface QueryDefaults {
  gcTime?: number;
  staleTime?: number;
}

export interface QueryCacheOptions {
  defaultOptions?: {
    queries?: QueryDefaults;
  };
}

export interface QueryEntry<T = unknown> {
  data: T | undefined;
  error: Error | null;
  /** Re-run by `invalidateQueries`; each observer registers one. */
  fetchers: Set<() => Promise<unknown>>;
  gcTimer: ReturnType<typeof setTimeout> | null;
  hasData: boolean;
  hash: string;
  isFetching: boolean;
  key: unknown[];
  observers: Set<() => void>;
  /** The in-flight request, so concurrent callers share one fetch. */
  promise: Promise<T> | null;
  queryFn: (() => Promise<T>) | null;
  staleTime: number;
  updatedAt: number;
}

/**
 * Canonicalises a key part so two structurally equal keys hash identically.
 *
 * Object key order is normalised because `{a, b}` and `{b, a}` are the same
 * query, and `undefined` is tagged because `JSON.stringify` would otherwise
 * drop it and collide with a missing property.
 */
export function normalizeForKey(value: unknown): unknown {
  if (value === undefined) {
    return { __type: "undefined" };
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeForKey);
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalizeForKey(item)]),
  );
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForKey(value));
}

export function resolveQueryKey(queryKey: QueryKey): unknown[] {
  return [...queryKey].map(normalizeForKey);
}

export function queryHash(queryKey: QueryKey): string {
  return stableStringify(resolveQueryKey(queryKey));
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Whether `key` starts with `prefix` — the invalidation match. */
export function keysMatch(key: unknown[], prefix: unknown[]): boolean {
  if (prefix.length > key.length) return false;

  return prefix.every(
    (part, index) => stableStringify(part) === stableStringify(key[index]),
  );
}

export function notify(entry: QueryEntry): void {
  for (const observer of entry.observers) {
    observer();
  }
}

export function isFresh(entry: QueryEntry): boolean {
  return entry.hasData && Date.now() - entry.updatedAt < entry.staleTime;
}

/**
 * Fetches an entry, unless it is fresh or already in flight.
 *
 * `force` skips the freshness check but still joins an in-flight request, so a
 * burst of invalidations produces one network call rather than one each.
 */
export async function fetchEntry<T>(
  entry: QueryEntry<T>,
  force = false,
): Promise<T | undefined> {
  if (!force && isFresh(entry)) {
    return entry.data;
  }

  if (!entry.queryFn) {
    return entry.data;
  }

  if (entry.promise) {
    return entry.promise;
  }

  entry.isFetching = true;
  notify(entry);

  entry.promise = entry
    .queryFn()
    .then((result) => {
      entry.data = result;
      entry.hasData = true;
      entry.error = null;
      entry.updatedAt = Date.now();
      return result;
    })
    .catch((error: unknown) => {
      entry.error = toError(error);
      throw entry.error;
    })
    .finally(() => {
      entry.isFetching = false;
      entry.promise = null;
      notify(entry);
    });

  notify(entry);
  return entry.promise;
}

export class QueryCache {
  private readonly cache = new Map<string, QueryEntry>();
  private readonly defaultOptions: QueryDefaults;

  constructor(options: QueryCacheOptions = {}) {
    this.defaultOptions = options.defaultOptions?.queries ?? {};
  }

  getDefaultOptions(): QueryDefaults {
    return this.defaultOptions;
  }

  getEntry<T>(queryKey: QueryKey): QueryEntry<T> {
    const key = resolveQueryKey(queryKey);
    const hash = stableStringify(key);
    const existing = this.cache.get(hash) as QueryEntry<T> | undefined;

    if (existing) {
      return existing;
    }

    const entry: QueryEntry<T> = {
      data: undefined,
      error: null,
      fetchers: new Set(),
      gcTimer: null,
      hasData: false,
      hash,
      isFetching: false,
      key,
      observers: new Set(),
      promise: null,
      queryFn: null,
      staleTime: this.defaultOptions.staleTime ?? 0,
      updatedAt: 0,
    };

    this.cache.set(hash, entry as QueryEntry);
    return entry;
  }

  setQueryData<T>(
    queryKey: QueryKey,
    updater: QueryDataUpdater<T>,
    options?: { stale?: boolean },
  ): void {
    const entry = this.getEntry<T>(queryKey);
    const nextData =
      typeof updater === "function"
        ? (updater as (old: T | undefined) => T | undefined)(entry.data)
        : updater;

    entry.data = nextData;
    entry.hasData = true;
    entry.error = null;
    // `stale: true` writes the value but leaves it due for a refetch — used
    // where a local edit is known to be incomplete.
    entry.updatedAt = options?.stale ? 0 : Date.now();
    notify(entry);
  }

  getQueryData<T>(queryKey: QueryKey): T | undefined {
    return this.getEntry<T>(queryKey).data;
  }

  /** Marks every entry under `queryKey` stale and refetches the observed ones. */
  invalidateQueries(options: { queryKey: QueryKey }): void {
    const prefix = resolveQueryKey(options.queryKey);

    for (const entry of this.cache.values()) {
      if (!keysMatch(entry.key, prefix)) continue;

      entry.updatedAt = 0;
      for (const fetch of entry.fetchers) {
        void fetch();
      }
    }
  }

  removeEntry(hash: string): void {
    this.cache.delete(hash);
  }
}
