import { QueryClient } from "./query.ts";

/**
 * The query client an island renders against.
 *
 * Explicit rather than falling through to the binding's module-level fallback,
 * for two reasons:
 *
 * - **Defaults.** A bare `new QueryClient()` has `staleTime: 0`, so every query
 *   refetches on every mount. The app is built against 30s.
 * - **Request isolation.** A module-level client is created once per *process*
 *   on the server, so every SSR render would share one cache and one request's
 *   data could reach another's markup. The browser wants the opposite — islands
 *   are separate Solid roots that should share a cache.
 */
function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: 1000 * 30,
        staleTime: 1000 * 30,
      },
    },
  });
}

const browserQueryClient = typeof window === "undefined" ? null : createQueryClient();

/** Shared across islands in the browser; a fresh one per render on the server. */
export function islandQueryClient(): QueryClient {
  return browserQueryClient ?? createQueryClient();
}
