import { beforeEach, describe, expect, it } from "bun:test";
import { type App, computed, effectScope, nextTick, ref } from "vue";
import {
  QueryClient,
  QueryPlugin,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "../src/composeables/query.ts";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function flushAsync() {
  await nextTick();
  await wait();
  await nextTick();
}

async function waitFor(assertion: () => void, timeout = 250) {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeout) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await wait(5);
    }
  }

  throw lastError;
}

function installClient(options?: ConstructorParameters<typeof QueryClient>[0]) {
  const queryClient = new QueryClient(options);
  QueryPlugin.install({} as App, { queryClient });
  return queryClient;
}

beforeEach(() => {
  installClient();
});

describe("query client", () => {
  it("fetches query data and exposes loading state", async () => {
    let calls = 0;
    const scope = effectScope();

    const query = scope.run(() =>
      useQuery({
        queryKey: ["document", "doc_1"],
        queryFn: async () => {
          calls++;
          return { id: "doc_1", title: "Document" };
        },
      }),
    )!;

    expect(query.data.value).toBeUndefined();
    expect(query.isPending.value).toBe(true);
    expect(query.isFetching.value).toBe(true);

    await waitFor(() => {
      expect(query.data.value).toEqual({ id: "doc_1", title: "Document" });
      expect(query.isPending.value).toBe(false);
      expect(query.isFetching.value).toBe(false);
    });
    expect(calls).toBe(1);

    scope.stop();
  });

  it("stores query errors and exposes isError", async () => {
    const scope = effectScope();
    const query = scope.run(() =>
      useQuery({
        queryKey: ["broken"],
        queryFn: async () => {
          throw new Error("failed");
        },
      }),
    )!;

    await waitFor(() => {
      expect(query.error.value?.message).toBe("failed");
      expect(query.isError.value).toBe(true);
      expect(query.isPending.value).toBe(false);
    });

    scope.stop();
  });

  it("does not fetch disabled queries until enabled becomes true", async () => {
    let calls = 0;
    const enabled = ref(false);
    const scope = effectScope();

    const query = scope.run(() =>
      useQuery({
        queryKey: ["members", "space_1"],
        enabled,
        queryFn: async () => {
          calls++;
          return ["Ada"];
        },
      }),
    )!;

    await flushAsync();
    expect(calls).toBe(0);
    expect(query.isPending.value).toBe(false);
    expect(query.data.value).toBeUndefined();

    enabled.value = true;

    await waitFor(() => {
      expect(query.data.value).toEqual(["Ada"]);
    });
    expect(calls).toBe(1);

    scope.stop();
  });

  it("reacts to computed query key changes", async () => {
    const documentId = ref("doc_1");
    const scope = effectScope();

    const query = scope.run(() =>
      useQuery({
        queryKey: computed(() => ["document", documentId.value]),
        queryFn: async () => ({ id: documentId.value }),
      }),
    )!;

    await waitFor(() => {
      expect(query.data.value).toEqual({ id: "doc_1" });
    });

    documentId.value = "doc_2";

    await waitFor(() => {
      expect(query.data.value).toEqual({ id: "doc_2" });
    });

    scope.stop();
  });

  it("reuses fresh cached data across observers", async () => {
    installClient({
      defaultOptions: {
        queries: {
          staleTime: 1_000,
        },
      },
    });

    let calls = 0;
    const firstScope = effectScope();
    const firstQuery = firstScope.run(() =>
      useQuery({
        queryKey: ["spaces"],
        queryFn: async () => {
          calls++;
          return ["Space"];
        },
      }),
    )!;

    await waitFor(() => {
      expect(firstQuery.data.value).toEqual(["Space"]);
    });
    firstScope.stop();

    const secondScope = effectScope();
    const secondQuery = secondScope.run(() =>
      useQuery({
        queryKey: ["spaces"],
        queryFn: async () => {
          calls++;
          return ["Space"];
        },
      }),
    )!;

    await flushAsync();
    expect(secondQuery.data.value).toEqual(["Space"]);
    expect(calls).toBe(1);

    secondScope.stop();
  });

  it("refetch bypasses staleTime and updates cached data", async () => {
    installClient({
      defaultOptions: {
        queries: {
          staleTime: 1_000,
        },
      },
    });

    let value = 0;
    const scope = effectScope();
    const query = scope.run(() =>
      useQuery({
        queryKey: ["counter"],
        queryFn: async () => ++value,
      }),
    )!;

    await waitFor(() => {
      expect(query.data.value).toBe(1);
    });

    await query.refetch();

    expect(query.data.value).toBe(2);
    scope.stop();
  });

  it("garbage-collects unobserved queries after gcTime", async () => {
    installClient({
      defaultOptions: {
        queries: {
          gcTime: 5,
          staleTime: 10_000,
        },
      },
    });

    let calls = 0;
    const firstScope = effectScope();
    const firstQuery = firstScope.run(() =>
      useQuery({
        queryKey: ["gc"],
        queryFn: async () => ++calls,
      }),
    )!;

    await waitFor(() => {
      expect(firstQuery.data.value).toBe(1);
    });
    firstScope.stop();

    await wait(20);

    const secondScope = effectScope();
    const secondQuery = secondScope.run(() =>
      useQuery({
        queryKey: ["gc"],
        queryFn: async () => ++calls,
      }),
    )!;

    await waitFor(() => {
      expect(secondQuery.data.value).toBe(2);
    });

    secondScope.stop();
  });

  it("setQueryData updates active observers with values and updater functions", async () => {
    const queryClient = installClient();
    const scope = effectScope();
    const query = scope.run(() =>
      useQuery<number[]>({
        queryKey: ["categories"],
        queryFn: async () => [1],
      }),
    )!;

    await waitFor(() => {
      expect(query.data.value).toEqual([1]);
    });

    queryClient.setQueryData<number[]>(["categories"], (old) => [...(old ?? []), 2]);
    expect(query.data.value).toEqual([1, 2]);

    queryClient.setQueryData<number[]>(["categories"], [3]);
    expect(query.data.value).toEqual([3]);
    expect(queryClient.getQueryData<number[]>(["categories"])).toEqual([3]);

    scope.stop();
  });

  it("invalidateQueries refetches matching active query keys", async () => {
    const queryClient = installClient();
    let documentCalls = 0;
    let categoryCalls = 0;
    const scope = effectScope();

    const documentQuery = scope.run(() =>
      useQuery({
        queryKey: ["wiki_document", "space_1", "doc_1"],
        queryFn: async () => ++documentCalls,
      }),
    )!;
    const categoryQuery = scope.run(() =>
      useQuery({
        queryKey: ["wiki_categories", "space_1"],
        queryFn: async () => ++categoryCalls,
      }),
    )!;

    await waitFor(() => {
      expect(documentQuery.data.value).toBe(1);
      expect(categoryQuery.data.value).toBe(1);
    });

    queryClient.invalidateQueries({ queryKey: ["wiki_document", "space_1"] });

    await waitFor(() => {
      expect(documentQuery.data.value).toBe(2);
    });
    expect(categoryQuery.data.value).toBe(1);

    scope.stop();
  });

  it("keeps placeholder data visible while a new key is loading", async () => {
    const page = ref(1);
    let releaseSecondPage!: (items: string[]) => void;
    const scope = effectScope();

    const query = scope.run(() =>
      useQuery({
        queryKey: computed(() => ["search", page.value]),
        queryFn: async () => {
          if (page.value === 1) return ["first"];
          return await new Promise<string[]>((resolve) => {
            releaseSecondPage = resolve;
          });
        },
        placeholderData: (previous) => previous,
      }),
    )!;

    await waitFor(() => {
      expect(query.data.value).toEqual(["first"]);
    });

    page.value = 2;
    await flushAsync();

    expect(query.data.value).toEqual(["first"]);
    expect(query.isPending.value).toBe(false);
    expect(query.isFetching.value).toBe(true);

    releaseSecondPage(["second"]);

    await waitFor(() => {
      expect(query.data.value).toEqual(["second"]);
      expect(query.isFetching.value).toBe(false);
    });

    scope.stop();
  });

  it("normalizes object query keys so property order does not split cache entries", async () => {
    const queryClient = installClient();
    let calls = 0;
    const scope = effectScope();

    const query = scope.run(() =>
      useQuery({
        queryKey: ["paged", { offset: 0, limit: 20 }],
        queryFn: async () => ++calls,
      }),
    )!;

    await waitFor(() => {
      expect(query.data.value).toBe(1);
    });

    queryClient.setQueryData(["paged", { limit: 20, offset: 0 }], 42);
    expect(query.data.value).toBe(42);
    expect(calls).toBe(1);

    scope.stop();
  });

  it("provides the active query client", () => {
    const queryClient = installClient();
    const scope = effectScope();

    const resolved = scope.run(() => useQueryClient())!;

    expect(resolved).toBe(queryClient);
    scope.stop();
  });
});

describe("mutation helper", () => {
  it("runs mutation lifecycle callbacks and exposes pending state", async () => {
    const events: string[] = [];
    const scope = effectScope();

    const mutation = scope.run(() =>
      useMutation<string, string, { snapshot: string }>({
        mutationFn: async (value) => {
          expect(mutation.isPending.value).toBe(true);
          events.push(`mutation:${value}`);
          return value.toUpperCase();
        },
        onMutate: (value) => {
          events.push(`mutate:${value}`);
          return { snapshot: "before" };
        },
        onSuccess: (data, variables, context) => {
          events.push(`success:${data}:${variables}:${context?.snapshot}`);
        },
        onSettled: (data, error, variables, context) => {
          events.push(
            `settled:${data}:${error?.message ?? "none"}:${variables}:${context?.snapshot}`,
          );
        },
      }),
    )!;

    const result = await mutation.mutateAsync("save");

    expect(result).toBe("SAVE");
    expect(mutation.data.value).toBe("SAVE");
    expect(mutation.error.value).toBeNull();
    expect(mutation.isPending.value).toBe(false);
    expect(events).toEqual([
      "mutate:save",
      "mutation:save",
      "success:SAVE:save:before",
      "settled:SAVE:none:save:before",
    ]);

    scope.stop();
  });

  it("stores mutation errors, calls onError, and rethrows", async () => {
    const events: string[] = [];
    const scope = effectScope();
    const mutation = scope.run(() =>
      useMutation<string, string, { snapshot: string }>({
        mutationFn: async () => {
          throw new Error("nope");
        },
        onMutate: () => ({ snapshot: "before" }),
        onError: (error, variables, context) => {
          events.push(`error:${error.message}:${variables}:${context?.snapshot}`);
        },
        onSettled: (data, error, variables, context) => {
          events.push(
            `settled:${data ?? "none"}:${error?.message}:${variables}:${context?.snapshot}`,
          );
        },
      }),
    )!;

    await expect(mutation.mutateAsync("delete")).rejects.toThrow("nope");

    expect(mutation.error.value?.message).toBe("nope");
    expect(mutation.isError.value).toBe(true);
    expect(mutation.isPending.value).toBe(false);
    expect(events).toEqual([
      "error:nope:delete:before",
      "settled:none:nope:delete:before",
    ]);

    scope.stop();
  });

  it("mutate swallows rejected promises while still updating error state", async () => {
    const scope = effectScope();
    const mutation = scope.run(() =>
      useMutation({
        mutationFn: async () => {
          throw new Error("background failure");
        },
      }),
    )!;

    mutation.mutate(undefined);

    await waitFor(() => {
      expect(mutation.error.value?.message).toBe("background failure");
      expect(mutation.isPending.value).toBe(false);
    });

    scope.stop();
  });
});

describe("infinite query helper", () => {
  it("fetches the first page and appends next pages", async () => {
    const scope = effectScope();
    const query = scope.run(() =>
      useInfiniteQuery({
        queryKey: ["documents", "space_1"],
        initialPageParam: 0,
        queryFn: async ({ pageParam }) => ({
          documents: [`doc_${pageParam}`],
          total: 2,
        }),
        getNextPageParam: (lastPage, allPages) => {
          const loadedCount = allPages.reduce(
            (sum, page) => sum + page.documents.length,
            0,
          );
          return loadedCount < lastPage.total ? loadedCount : undefined;
        },
      }),
    )!;

    await waitFor(() => {
      expect(query.data.value?.pages).toEqual([{ documents: ["doc_0"], total: 2 }]);
      expect(query.hasNextPage.value).toBe(true);
    });

    await query.fetchNextPage();

    expect(query.data.value?.pages).toEqual([
      { documents: ["doc_0"], total: 2 },
      { documents: ["doc_1"], total: 2 },
    ]);
    expect(query.data.value?.pageParams).toEqual([0, 1]);
    expect(query.hasNextPage.value).toBe(false);
    expect(query.isFetchingNextPage.value).toBe(false);

    scope.stop();
  });

  it("does not fetch another page when getNextPageParam returns undefined", async () => {
    let calls = 0;
    const scope = effectScope();
    const query = scope.run(() =>
      useInfiniteQuery({
        queryKey: ["documents", "space_1"],
        initialPageParam: 0,
        queryFn: async ({ pageParam }) => {
          calls++;
          return { documents: [`doc_${pageParam}`], total: 1 };
        },
        getNextPageParam: () => undefined,
      }),
    )!;

    await waitFor(() => {
      expect(query.data.value?.pages).toHaveLength(1);
    });

    await query.fetchNextPage();

    expect(calls).toBe(1);
    expect(query.data.value?.pages).toHaveLength(1);

    scope.stop();
  });
});
