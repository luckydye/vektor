import type { App } from "vue";
import { QueryClient, QueryPlugin } from "./composeables/query.ts";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 1000 * 30,
      staleTime: 1000 * 30,
    },
  },
});

export default (app: App) => {
  app.use(QueryPlugin, { queryClient });
};
