import type { App } from "vue";
import { QueryClient, QueryPlugin } from "./composeables/query.ts";

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

// Astro islands are separate Vue apps in the browser and intentionally share
// one cache. On the server every app/render gets its own cache so request data
// can never survive in the module graph or race with another request.
const browserQueryClient = typeof window === "undefined" ? null : createQueryClient();

export default (app: App) => {
  app.use(QueryPlugin, { queryClient: browserQueryClient ?? createQueryClient() });
};
