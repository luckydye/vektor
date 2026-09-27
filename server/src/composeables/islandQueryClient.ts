import { QueryClient, setFallbackQueryClient } from "./query.ts";

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

// A composable called from an island's *own body* sits above the provider that
// island renders, so it resolves to the binding's fallback client. In the
// browser that has to be this same client, or the two caches each fetch, each
// store, and each re-render the same query. The server keeps its per-request
// fallback: there, one client per process is precisely the leak to avoid.
if (browserQueryClient) setFallbackQueryClient(browserQueryClient);

/** Shared across islands in the browser; a fresh one per render on the server. */
export function islandQueryClient(): QueryClient {
  return browserQueryClient ?? createQueryClient();
}
