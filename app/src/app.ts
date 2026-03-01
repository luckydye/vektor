import type { App } from "vue";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 1000 * 30,
      staleTime: 1000 * 30,
    },
  },
});

export default (app: App) => {
  app.use(VueQueryPlugin, { queryClient });
};
