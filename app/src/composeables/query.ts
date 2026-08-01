import {
  type Accessor,
  createContext,
  createMemo,
  createRenderEffect,
  createSignal,
  onCleanup,
  untrack,
  useContext,
} from "solid-js";
import {
  fetchEntry,
  QueryCache,
  type QueryCacheOptions,
  type QueryDataUpdater,
  type QueryDefaults,
  type QueryEntry,
  type QueryKey,
  queryHash,
  toError,
} from "./queryCore.ts";

/**
 * The Solid binding over `queryCore.ts`.
 *
 * The cache, hashing, freshness and invalidation live in the core; this file
 * only turns an entry's `observers` set into signals.
 *
 * The *whole* key may be an accessor, and its contents are plain:
 *
 *     useQuery({ queryKey: () => ["documents", spaceId()], ... })
 *
 * Per-value accessors would be ambiguous — a function inside a key could be
 * reactive or just a value.
 */

export type MaybeAccessor<T> = T | Accessor<T>;

/** Reads a value that may be an accessor. */
export function access<T>(value: MaybeAccessor<T>): T {
  return typeof value === "function" ? (value as Accessor<T>)() : value;
}

export interface UseQueryOptions<TData> {
  enabled?: MaybeAccessor<boolean>;
  /** Hydrates an otherwise empty query before its network request resolves. */
  initialData?: () => Promise<TData | undefined>;
  placeholderData?: (previousData: TData | undefined) => TData | undefined;
  queryFn: () => Promise<TData>;
  queryKey: MaybeAccessor<QueryKey>;
  /** Receives authoritative and optimistic updates from an external data source. */
  subscribe?: (callback: (data: TData | undefined) => void) => () => void;
  staleTime?: number;
}

export interface UseMutationOptions<TData, TVariables, TContext> {
  mutationFn: (variables: TVariables) => Promise<TData>;
  onError?: (
    error: Error,
    variables: TVariables,
    context: TContext | undefined,
  ) => void | Promise<void>;
  onMutate?: (variables: TVariables) => TContext | Promise<TContext>;
  onSettled?: (
    data: TData | undefined,
    error: Error | null,
    variables: TVariables,
    context: TContext | undefined,
  ) => void | Promise<void>;
  onSuccess?: (
    data: TData,
    variables: TVariables,
    context: TContext | undefined,
  ) => void | Promise<void>;
}

export interface UseInfiniteQueryOptions<TPage, TPageParam> {
  enabled?: MaybeAccessor<boolean>;
  getNextPageParam: (lastPage: TPage, allPages: TPage[]) => TPageParam | undefined;
  initialPageParam: TPageParam;
  queryFn: (context: { pageParam: TPageParam }) => Promise<TPage>;
  queryKey: MaybeAccessor<QueryKey>;
  staleTime?: number;
}

export interface InfiniteData<TPage, TPageParam = unknown> {
  pages: TPage[];
  pageParams: TPageParam[];
}

/** The Solid-facing cache handle. Keys are plain here; callers resolve first. */
export class QueryClient {
  private readonly cache: QueryCache;

  constructor(options: QueryCacheOptions = {}) {
    this.cache = new QueryCache(options);
  }

  getDefaultOptions(): QueryDefaults {
    return this.cache.getDefaultOptions();
  }

  getEntry<T>(queryKey: QueryKey): QueryEntry<T> {
    return this.cache.getEntry<T>(queryKey);
  }

  setQueryData<T>(
    queryKey: QueryKey,
    updater: QueryDataUpdater<T>,
    options?: { stale?: boolean },
  ): void {
    this.cache.setQueryData(queryKey, updater, options);
  }

  getQueryData<T>(queryKey: QueryKey): T | undefined {
    return this.cache.getQueryData<T>(queryKey);
  }

  invalidateQueries(options: { queryKey: QueryKey }): void {
    this.cache.invalidateQueries(options);
  }

  removeEntry(hash: string): void {
    this.cache.removeEntry(hash);
  }
}

/**
 * One client per render, so concurrent SSR requests never share a cache.
 *
 * The fallback exists because composables are also used outside any component
 * — in plain modules and in tests — and those need a client without a
 * provider above them.
 */
export const QueryClientContext = createContext<QueryClient>();

let fallbackQueryClient = new QueryClient();

/**
 * Replaces the no-provider client, so callers above a provider — or outside
 * any component — share the cache the app actually renders against.
 */
export function setFallbackQueryClient(client: QueryClient): void {
  fallbackQueryClient = client;
}

export function useQueryClient(): QueryClient {
  return useContext(QueryClientContext) ?? fallbackQueryClient;
}

function resolveEnabled(enabled: MaybeAccessor<boolean> | undefined): boolean {
  return enabled === undefined ? true : access(enabled);
}

export interface QueryResult<TData> {
  data: Accessor<TData | undefined>;
  error: Accessor<Error | null>;
  isError: Accessor<boolean>;
  isFetching: Accessor<boolean>;
  isLoading: Accessor<boolean>;
  isPending: Accessor<boolean>;
  refetch: () => Promise<TData | undefined>;
}

export function useQuery<TData = unknown>(
  options: UseQueryOptions<TData>,
): QueryResult<TData> {
  const queryClient = useQueryClient();
  const [data, setData] = createSignal<TData | undefined>(undefined);
  const [error, setError] = createSignal<Error | null>(null);
  const [hasData, setHasData] = createSignal(false);
  const [isFetching, setIsFetching] = createSignal(false);
  const [isEnabled, setIsEnabled] = createSignal(false);

  let currentEntry: QueryEntry<TData> | null = null;
  let currentObserver: (() => void) | null = null;
  let currentFetcher: (() => Promise<unknown>) | null = null;
  let currentDataSubscription: (() => void) | null = null;
  let hasPlaceholder = false;
  let placeholderData: TData | undefined;
  let previousData: TData | undefined;

  const cleanup = () => {
    if (!currentEntry) return;

    if (currentObserver) currentEntry.observers.delete(currentObserver);
    if (currentFetcher) currentEntry.fetchers.delete(currentFetcher);
    currentDataSubscription?.();

    const entry = currentEntry;
    currentEntry = null;
    currentObserver = null;
    currentFetcher = null;
    currentDataSubscription = null;

    if (entry.observers.size === 0) {
      if (entry.gcTimer) clearTimeout(entry.gcTimer);
      const gcTime = queryClient.getDefaultOptions().gcTime;
      if (gcTime !== undefined) {
        entry.gcTimer = setTimeout(() => {
          if (entry.observers.size === 0) queryClient.removeEntry(entry.hash);
        }, gcTime);
      }
    }
  };

  const attach = (queryKey: QueryKey, enabled: boolean) => {
    const entry = queryClient.getEntry<TData>(queryKey);
    const hadCachedData = entry.hasData;

    if (entry.gcTimer) {
      clearTimeout(entry.gcTimer);
      entry.gcTimer = null;
    }

    entry.queryFn = options.queryFn;
    entry.staleTime = options.staleTime ?? queryClient.getDefaultOptions().staleTime ?? 0;
    currentEntry = entry;
    setIsEnabled(enabled);
    hasPlaceholder = false;
    placeholderData = undefined;

    if (!hadCachedData && options.placeholderData) {
      const placeholder = options.placeholderData(previousData);
      if (placeholder !== undefined) {
        placeholderData = placeholder;
        hasPlaceholder = true;
      }
    }

    currentObserver = () => {
      if (entry.hasData) {
        hasPlaceholder = false;
        placeholderData = undefined;
        setData(() => entry.data);
        setHasData(true);
      } else if (hasPlaceholder) {
        setData(() => placeholderData);
        setHasData(true);
      } else {
        setData(undefined);
        setHasData(false);
      }
      setError(entry.error);
      setIsFetching(entry.isFetching);
    };

    currentFetcher = async () => {
      if (!untrack(() => resolveEnabled(options.enabled))) return undefined;
      return await fetchEntry(entry, true).catch(() => undefined);
    };

    entry.observers.add(currentObserver);
    entry.fetchers.add(currentFetcher);
    currentObserver();

    if (!hadCachedData && options.initialData) {
      void options
        .initialData()
        .then((initialData) => {
          // A remote response is always newer than IndexedDB hydration.
          if (entry !== currentEntry || entry.hasData || initialData === undefined)
            return;
          queryClient.setQueryData(queryKey, initialData);
        })
        .catch(() => undefined);
    }

    if (options.subscribe) {
      currentDataSubscription = options.subscribe((nextData) => {
        if (entry !== currentEntry || nextData === undefined) return;
        queryClient.setQueryData(queryKey, nextData);
      });
    }

    if (enabled) {
      void fetchEntry(entry).catch(() => undefined);
    }
  };

  // A render effect, not `createEffect`: attaching must happen synchronously at
  // creation so a caller can read `isPending()` on the same tick. A deferred
  // effect would report "idle, no data" for one tick on every mount.
  //
  // Reading the key and `enabled` here is what tracks them; everything attach()
  // does is untracked, so the observer's own writes cannot re-trigger it.
  // Depend on the hash rather than the array, so an equal key rebuilt inline on
  // every render does not detach and refetch.
  //
  // This has to be a memo over the hash *string*. `createMemo` compares with
  // `===`, and a key built inline — `createMemo(() => ["docs", props.spaceId])`
  // — is a new array on every recomputation, so the array itself always reads
  // as changed. Calling `queryHash` inside the effect (as this once did) tracks
  // nothing at all: it is a pure function, and the dependency had already been
  // taken on the key.
  //
  // The difference is not just wasted fetches. A re-attach calls `fetchEntry`,
  // which notifies every observer of the shared cache entry — including one
  // whose data feeds this key. Rendering a list of components that each read
  // such a query then loops: attach, fetch, notify, re-render, attach.
  const keyHash = createMemo(() => queryHash(access(options.queryKey)));

  createRenderEffect(() => {
    void keyHash();
    const enabled = resolveEnabled(options.enabled);

    untrack(() => {
      const queryKey = access(options.queryKey);
      previousData = data();
      cleanup();
      attach(queryKey, enabled);
    });
  });

  onCleanup(cleanup);

  const isPending = createMemo(() => isEnabled() && !hasData() && isFetching());

  return {
    data,
    error,
    isError: createMemo(() => error() !== null),
    isFetching,
    isLoading: isPending,
    isPending,
    refetch: async () => {
      if (!currentEntry) return undefined;
      return await fetchEntry(currentEntry, true).catch(() => undefined);
    },
  };
}

export function useMutation<TData = unknown, TVariables = void, TContext = unknown>(
  options: UseMutationOptions<TData, TVariables, TContext>,
) {
  const [data, setData] = createSignal<TData | undefined>(undefined);
  const [error, setError] = createSignal<Error | null>(null);
  const [isPending, setIsPending] = createSignal(false);

  const mutateAsync = async (variables: TVariables): Promise<TData> => {
    let context: TContext | undefined;
    setIsPending(true);
    setError(null);

    try {
      context = await options.onMutate?.(variables);
      const result = await options.mutationFn(variables);
      setData(() => result);
      await options.onSuccess?.(result, variables, context);
      await options.onSettled?.(result, null, variables, context);
      return result;
    } catch (rawError) {
      const mutationError = toError(rawError);
      setError(mutationError);
      await options.onError?.(mutationError, variables, context);
      await options.onSettled?.(undefined, mutationError, variables, context);
      throw mutationError;
    } finally {
      setIsPending(false);
    }
  };

  return {
    data,
    error,
    isError: createMemo(() => error() !== null),
    isPending,
    mutate: (variables: TVariables): void => {
      void mutateAsync(variables).catch(() => undefined);
    },
    mutateAsync,
  };
}

/**
 * Accumulating pagination: every fetched page stays in `data().pages`, and
 * `fetchNextPage` appends. For load-more and infinite-scroll lists.
 *
 * **Pick this or `useCursorPagedList`?** That one is a *pager* — one page
 * visible at a time, with `prevPage`/`nextPage` replacing it. This one only
 * moves forward and never drops what it has. Choose by the UI you want, not by
 * the endpoint: both sit on the same `useQuery` cache, the same endpoint is
 * read both ways where two views want different shapes, and one view showing
 * two lists may need both.
 */
export function useInfiniteQuery<TPage, TPageParam = unknown>(
  options: UseInfiniteQueryOptions<TPage, TPageParam>,
) {
  const [isFetchingNextPage, setIsFetchingNextPage] = createSignal(false);
  const [pageError, setPageError] = createSignal<Error | null>(null);
  const queryClient = useQueryClient();

  const query = useQuery<InfiniteData<TPage, TPageParam>>({
    enabled: options.enabled,
    queryKey: options.queryKey,
    queryFn: async () => {
      const firstPage = await options.queryFn({ pageParam: options.initialPageParam });
      return { pageParams: [options.initialPageParam], pages: [firstPage] };
    },
    staleTime: options.staleTime,
  });

  const hasNextPage = createMemo(() => {
    const current = query.data();
    if (!current || current.pages.length === 0) return false;

    return (
      options.getNextPageParam(current.pages[current.pages.length - 1], current.pages) !==
      undefined
    );
  });

  const fetchNextPage = async () => {
    const current = untrack(query.data);
    if (!current || current.pages.length === 0 || untrack(isFetchingNextPage)) return;

    const nextPageParam = options.getNextPageParam(
      current.pages[current.pages.length - 1],
      current.pages,
    );
    if (nextPageParam === undefined) return;

    setIsFetchingNextPage(true);
    try {
      const nextPage = await options.queryFn({ pageParam: nextPageParam });
      queryClient.setQueryData<InfiniteData<TPage, TPageParam>>(
        access(options.queryKey),
        (old) => ({
          pageParams: [...(old?.pageParams ?? []), nextPageParam],
          pages: [...(old?.pages ?? []), nextPage],
        }),
      );
    } catch (rawError) {
      setPageError(toError(rawError));
    } finally {
      setIsFetchingNextPage(false);
    }
  };

  return {
    ...query,
    // A page failure belongs to this helper, not to the cached entry: the
    // first page is still valid data. Writing it onto the shared query error
    // would make a failed "load more" look like the whole list had failed.
    error: createMemo(() => pageError() ?? query.error()),
    isError: createMemo(() => (pageError() ?? query.error()) !== null),
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  };
}
