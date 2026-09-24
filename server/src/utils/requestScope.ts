/**
 * A memo that lasts exactly one request, for work whose cost belongs to the
 * request rather than to each caller inside it — a group claim bounded against
 * an identity provider, above all. Outside a scope nothing is cached.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestScope<T> {
  /** Run `handler` with a fresh, empty scope. */
  within<R>(handler: () => R): R;
  /**
   * The value for `key` in the current scope, computed at most once. Computed
   * every time when there is no scope open.
   */
  memoize(key: string, compute: () => Promise<T>): Promise<T>;
}

export function createRequestScope<T>(): RequestScope<T> {
  const storage = new AsyncLocalStorage<Map<string, Promise<T>>>();

  return {
    within(handler) {
      return storage.run(new Map(), handler);
    },

    memoize(key, compute) {
      const cache = storage.getStore();
      if (!cache) return compute();

      const known = cache.get(key);
      if (known) return known;

      // Held as the promise, not the result: two callers starting in parallel
      // share the one computation rather than race to make their own.
      const pending = compute();
      cache.set(key, pending);
      return pending;
    },
  };
}
