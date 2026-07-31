import { createComponent, createRoot, createSignal } from "solid-js";
import { beforeEach, describe, expect, it } from "vitest";
import {
  QueryClient,
  QueryClientContext,
  setFallbackQueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "#composeables/query.ts";

/**
 * Contract specs for the query binding.
 *
 * Runs under vitest, not `bun test`, and that is not a style choice: bun
 * resolves `solid-js` to its server build, where `createMemo` computes once and
 * never again. `isPending` would sit at its first value forever and the spec
 * would report a reactivity bug that does not exist. `vite-plugin-solid` sets
 * the browser/development conditions, so the client runtime is what gets
 * tested.
 *
 * Specs run inside `createRoot(dispose => …)`; disposing the root is what
 * unregisters observers.
 */

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function flushAsync() {
  await wait();
  await wait();
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
  setFallbackQueryClient(queryClient);
  return queryClient;
}

/** `createRoot` plus the disposer, so a test can tear its observers down. */
function inRoot<T>(run: () => T): [T, () => void] {
  let dispose!: () => void;
  const value = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return run();
  });
  return [value, dispose];
}

beforeEach(() => {
  installClient();
});

describe("query client", () => {
  it("isolates query data between roots", () => {
    const firstClient = new QueryClient();
    const secondClient = new QueryClient();
    firstClient.setQueryData(["current-user"], "first-user");
    secondClient.setQueryData(["current-user"], "second-user");

    const read = (client: QueryClient) =>
      createRoot((dispose) => {
        // A Provider hands its children back as a memo, so the read has to be
        // forced before the root is disposed.
        const children = createComponent(QueryClientContext.Provider, {
          value: client,
          get children() {
            return useQueryClient().getQueryData(["current-user"]);
          },
        });
        const value = typeof children === "function" ? children() : children;
        dispose();
        return value;
      });

    expect(read(firstClient)).toBe("first-user");
    expect(read(secondClient)).toBe("second-user");
  });

  it("fetches query data and exposes loading state", async () => {
    let calls = 0;
    const [query, dispose] = inRoot(() =>
      useQuery({
        queryKey: ["document", "doc_1"],
        queryFn: async () => {
          calls++;
          return { id: "doc_1", title: "Document" };
        },
      }),
    );

    expect(query.data()).toBeUndefined();
    expect(query.isPending()).toBe(true);
    expect(query.isFetching()).toBe(true);

    await waitFor(() => {
      expect(query.data()).toEqual({ id: "doc_1", title: "Document" });
      expect(query.isPending()).toBe(false);
      expect(query.isFetching()).toBe(false);
    });
    expect(calls).toBe(1);

    dispose();
  });

  it("stores query errors and exposes isError", async () => {
    const [query, dispose] = inRoot(() =>
      useQuery({
        queryKey: ["broken"],
        queryFn: async () => {
          throw new Error("failed");
        },
      }),
    );

    await waitFor(() => {
      expect(query.error()?.message).toBe("failed");
      expect(query.isError()).toBe(true);
      expect(query.isPending()).toBe(false);
    });

    dispose();
  });

  it("does not fetch disabled queries until enabled becomes true", async () => {
    let calls = 0;
    const [enabled, setEnabled] = createSignal(false);

    const [query, dispose] = inRoot(() =>
      useQuery({
        queryKey: ["members", "space_1"],
        enabled,
        queryFn: async () => {
          calls++;
          return ["Ada"];
        },
      }),
    );

    await flushAsync();
    expect(calls).toBe(0);
    expect(query.isPending()).toBe(false);
    expect(query.data()).toBeUndefined();

    setEnabled(true);

    await waitFor(() => {
      expect(query.data()).toEqual(["Ada"]);
    });
    expect(calls).toBe(1);

    dispose();
  });

  it("reacts to reactive query key changes", async () => {
    const [documentId, setDocumentId] = createSignal("doc_1");

    const [query, dispose] = inRoot(() =>
      useQuery({
        queryKey: () => ["document", documentId()],
        queryFn: async () => ({ id: documentId() }),
      }),
    );

    await waitFor(() => {
      expect(query.data()).toEqual({ id: "doc_1" });
    });

    setDocumentId("doc_2");

    await waitFor(() => {
      expect(query.data()).toEqual({ id: "doc_2" });
    });

    dispose();
  });

  it("reuses fresh cached data across observers", async () => {
    installClient({ defaultOptions: { queries: { staleTime: 1_000 } } });

    let calls = 0;
    const queryFn = async () => {
      calls++;
      return ["Space"];
    };

    const [firstQuery, disposeFirst] = inRoot(() =>
      useQuery({ queryKey: ["spaces"], queryFn }),
    );
    await waitFor(() => {
      expect(firstQuery.data()).toEqual(["Space"]);
    });

    const [secondQuery, disposeSecond] = inRoot(() =>
      useQuery({ queryKey: ["spaces"], queryFn }),
    );
    await flushAsync();

    expect(secondQuery.data()).toEqual(["Space"]);
    expect(calls).toBe(1);

    disposeFirst();
    disposeSecond();
  });

  it("refetch bypasses staleTime and updates cached data", async () => {
    installClient({ defaultOptions: { queries: { staleTime: 60_000 } } });

    let calls = 0;
    const [query, dispose] = inRoot(() =>
      useQuery({
        queryKey: ["counter"],
        queryFn: async () => {
          calls++;
          return calls;
        },
      }),
    );

    await waitFor(() => {
      expect(query.data()).toBe(1);
    });

    await query.refetch();

    await waitFor(() => {
      expect(query.data()).toBe(2);
    });
    expect(calls).toBe(2);

    dispose();
  });

  it("garbage-collects unobserved queries after gcTime", async () => {
    const queryClient = installClient({
      defaultOptions: { queries: { gcTime: 10, staleTime: 60_000 } },
    });

    let calls = 0;
    const queryFn = async () => {
      calls++;
      return calls;
    };

    const [firstQuery, disposeFirst] = inRoot(() =>
      useQuery({ queryKey: ["temporary"], queryFn }),
    );
    await waitFor(() => {
      expect(firstQuery.data()).toBe(1);
    });

    disposeFirst();
    await wait(40);

    expect(queryClient.getQueryData(["temporary"])).toBeUndefined();

    const [secondQuery, disposeSecond] = inRoot(() =>
      useQuery({ queryKey: ["temporary"], queryFn }),
    );
    await waitFor(() => {
      expect(secondQuery.data()).toBe(2);
    });

    disposeSecond();
  });

  it("setQueryData updates active observers with values and updater functions", async () => {
    const queryClient = installClient();

    const [query, dispose] = inRoot(() =>
      useQuery({
        queryKey: ["title"],
        queryFn: async () => "first",
      }),
    );

    await waitFor(() => {
      expect(query.data()).toBe("first");
    });

    queryClient.setQueryData(["title"], "second");
    expect(query.data()).toBe("second");

    queryClient.setQueryData<string>(["title"], (old) => `${old}-updated`);
    expect(query.data()).toBe("second-updated");

    dispose();
  });

  it("invalidateQueries refetches matching active query keys", async () => {
    const queryClient = installClient({
      defaultOptions: { queries: { staleTime: 60_000 } },
    });

    let calls = 0;
    const [query, dispose] = inRoot(() =>
      useQuery({
        queryKey: ["documents", "space_1"],
        queryFn: async () => {
          calls++;
          return calls;
        },
      }),
    );

    await waitFor(() => {
      expect(query.data()).toBe(1);
    });

    queryClient.invalidateQueries({ queryKey: ["documents"] });

    await waitFor(() => {
      expect(query.data()).toBe(2);
    });
    expect(calls).toBe(2);

    dispose();
  });

  it("keeps placeholder data visible while a new key is loading", async () => {
    const [page, setPage] = createSignal(1);

    const [query, dispose] = inRoot(() =>
      useQuery<string[]>({
        queryKey: () => ["list", page()],
        placeholderData: (previous) => previous,
        queryFn: async () => {
          await wait(10);
          return [`page-${page()}`];
        },
      }),
    );

    await waitFor(() => {
      expect(query.data()).toEqual(["page-1"]);
    });

    setPage(2);
    // The previous page stays on screen instead of blanking out.
    expect(query.data()).toEqual(["page-1"]);

    await waitFor(() => {
      expect(query.data()).toEqual(["page-2"]);
    });

    dispose();
  });

  it("normalizes object query keys so property order does not split cache entries", async () => {
    const queryClient = installClient();

    const [query, dispose] = inRoot(() =>
      useQuery({
        queryKey: ["search", { limit: 10, term: "vektor" }],
        queryFn: async () => ["hit"],
      }),
    );

    await waitFor(() => {
      expect(query.data()).toEqual(["hit"]);
    });

    expect(queryClient.getQueryData(["search", { term: "vektor", limit: 10 }])).toEqual([
      "hit",
    ]);

    dispose();
  });

  it("provides the active query client", () => {
    const queryClient = installClient();
    const [resolved, dispose] = inRoot(() => useQueryClient());
    expect(resolved).toBe(queryClient);
    dispose();
  });
});

describe("mutation helper", () => {
  it("runs mutation lifecycle callbacks and exposes pending state", async () => {
    const events: string[] = [];

    const [mutation, dispose] = inRoot(() =>
      useMutation<string, { id: string }, { started: boolean }>({
        mutationFn: async (variables) => {
          events.push(`mutate:${variables.id}`);
          return `done:${variables.id}`;
        },
        onMutate: (variables) => {
          events.push(`onMutate:${variables.id}`);
          return { started: true };
        },
        onSuccess: (data, _variables, context) => {
          events.push(`onSuccess:${data}:${context?.started}`);
        },
        onSettled: (data, error) => {
          events.push(`onSettled:${data}:${error}`);
        },
      }),
    );

    const promise = mutation.mutateAsync({ id: "doc_1" });
    expect(mutation.isPending()).toBe(true);

    await expect(promise).resolves.toBe("done:doc_1");

    expect(mutation.isPending()).toBe(false);
    expect(mutation.data()).toBe("done:doc_1");
    expect(events).toEqual([
      "onMutate:doc_1",
      "mutate:doc_1",
      "onSuccess:done:doc_1:true",
      "onSettled:done:doc_1:null",
    ]);

    dispose();
  });

  it("stores mutation errors, calls onError, and rethrows", async () => {
    const events: string[] = [];

    const [mutation, dispose] = inRoot(() =>
      useMutation<string, void, undefined>({
        mutationFn: async () => {
          throw new Error("nope");
        },
        onError: (error) => {
          events.push(`onError:${error.message}`);
        },
        onSettled: (_data, error) => {
          events.push(`onSettled:${error?.message}`);
        },
      }),
    );

    await expect(mutation.mutateAsync()).rejects.toThrow("nope");

    expect(mutation.error()?.message).toBe("nope");
    expect(mutation.isError()).toBe(true);
    expect(mutation.isPending()).toBe(false);
    expect(events).toEqual(["onError:nope", "onSettled:nope"]);

    dispose();
  });

  it("mutate swallows rejected promises while still updating error state", async () => {
    const [mutation, dispose] = inRoot(() =>
      useMutation<string, void, undefined>({
        mutationFn: async () => {
          throw new Error("silent");
        },
      }),
    );

    mutation.mutate();

    await waitFor(() => {
      expect(mutation.error()?.message).toBe("silent");
      expect(mutation.isPending()).toBe(false);
    });

    dispose();
  });
});

describe("infinite query helper", () => {
  it("fetches the first page and appends next pages", async () => {
    const [query, dispose] = inRoot(() =>
      useInfiniteQuery<{ items: string[]; nextCursor?: string }, string | undefined>({
        queryKey: ["feed"],
        initialPageParam: undefined,
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        queryFn: async ({ pageParam }) =>
          pageParam === undefined
            ? { items: ["a"], nextCursor: "cursor-1" }
            : { items: ["b"] },
      }),
    );

    await waitFor(() => {
      expect(query.data()?.pages).toHaveLength(1);
      expect(query.hasNextPage()).toBe(true);
    });

    await query.fetchNextPage();

    await waitFor(() => {
      expect(query.data()?.pages).toHaveLength(2);
      expect(query.data()?.pages[1].items).toEqual(["b"]);
      expect(query.hasNextPage()).toBe(false);
      expect(query.isFetchingNextPage()).toBe(false);
    });

    dispose();
  });

  it("does not fetch another page when getNextPageParam returns undefined", async () => {
    let calls = 0;

    const [query, dispose] = inRoot(() =>
      useInfiniteQuery<{ items: string[] }, number>({
        queryKey: ["single-page"],
        initialPageParam: 0,
        getNextPageParam: () => undefined,
        queryFn: async () => {
          calls++;
          return { items: ["only"] };
        },
      }),
    );

    await waitFor(() => {
      expect(query.data()?.pages).toHaveLength(1);
    });

    await query.fetchNextPage();
    await flushAsync();

    expect(calls).toBe(1);
    expect(query.hasNextPage()).toBe(false);

    dispose();
  });
});

describe("external query data sources", () => {
  it("hydrates an empty query and never lets delayed hydration replace remote data", async () => {
    const [query, dispose] = inRoot(() =>
      useQuery<string>({
        queryKey: ["hydrated"],
        initialData: async () => {
          await wait(20);
          return "from-cache";
        },
        queryFn: async () => "from-network",
      }),
    );

    await waitFor(() => {
      expect(query.data()).toBe("from-network");
    });

    // The slow hydration resolves after the network response and must not win.
    await wait(40);
    expect(query.data()).toBe("from-network");

    dispose();
  });

  it("applies updates pushed from an external subscription", async () => {
    let push: ((data: string | undefined) => void) | null = null;

    const [query, dispose] = inRoot(() =>
      useQuery<string>({
        queryKey: ["subscribed"],
        queryFn: async () => "initial",
        subscribe: (callback) => {
          push = callback;
          return () => {
            push = null;
          };
        },
      }),
    );

    await waitFor(() => {
      expect(query.data()).toBe("initial");
    });

    push?.("pushed");
    expect(query.data()).toBe("pushed");

    dispose();
    expect(push).toBeNull();
  });
});
