/**
 * A memo that lasts exactly one request, for work whose cost belongs to the
 * request rather than to each caller inside it — a group claim bounded against
 * an identity provider, above all. Outside a scope nothing is cached.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface Scope {
  cache: Map<string, Promise<unknown>>;
  /** Cleared when the handler settles, so timers and promises it left behind stop reading the memo. */
  open: boolean;
}

const storage = new AsyncLocalStorage<Scope>();

/**
 * Opened around one HTTP request or one realtime frame and nothing longer-lived:
 * a websocket lasts days, and holding a group claim that long is what
 * `ensureFreshGroups` exists to bound.
 */
export const requestScope = {
  /** Run `handler` with a fresh, empty scope that closes when it settles. */
  within<R>(handler: () => R): R {
    const scope: Scope = { cache: new Map(), open: true };
    const result = storage.run(scope, handler);
    if (!(result instanceof Promise)) {
      scope.open = false;
      return result;
    }
    return result.finally(() => {
      scope.open = false;
    }) as R;
  },

  /**
   * Run `handler` in a fresh scope that stays open until its response body has
   * been produced, since a streamed page keeps rendering after the handler resolves.
   */
  async withinResponse(handler: () => Promise<Response>): Promise<Response> {
    const scope: Scope = { cache: new Map(), open: true };
    const close = () => {
      scope.open = false;
    };
    let response: Response;
    try {
      response = await storage.run(scope, handler);
    } catch (error) {
      close();
      throw error;
    }
    if (!response.body) {
      close();
      return response;
    }

    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          // In the scope, so a body rendered on demand still reads the memo.
          const { done, value } = await storage.run(scope, () => reader.read());
          if (done) {
            close();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          close();
          controller.error(error);
        }
      },
      cancel(reason) {
        close();
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  },

  /**
   * The value for `key` in the current scope, computed at most once. Computed
   * every time when no scope is open.
   */
  memoize<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const scope = storage.getStore();
    if (!scope?.open) return compute();

    const known = scope.cache.get(key);
    if (known) return known as Promise<T>;

    // Held as the promise, not the result: two callers starting in parallel
    // share the one computation rather than race to make their own.
    const pending = compute();
    scope.cache.set(key, pending);
    return pending;
  },

  /** Drop `key` from the current scope, after a write that changed its answer. */
  forget(key: string): void {
    storage.getStore()?.cache.delete(key);
  },
};
