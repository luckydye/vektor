import type { App, InjectionKey, MaybeRef, Ref, ShallowRef } from "vue";
import {
  computed,
  getCurrentInstance,
  inject,
  isRef,
  onScopeDispose,
  ref,
  shallowRef,
  toValue,
  watch,
} from "vue";
import {
  fetchEntry,
  queryHash as hashResolvedKey,
  QueryCache,
  type QueryCacheOptions,
  type QueryDataUpdater,
  type QueryDefaults,
  type QueryEntry,
  type QueryKey,
  toError,
} from "./queryCore.ts";

/**
 * The Vue binding over `queryCore.ts`.
 *
 * The cache, hashing, freshness and invalidation all live in the core; this
 * file is what turns an entry's `observers` set into refs, and what accepts
 * Vue's `MaybeRef` keys. A Solid binding is the same shape over the same cache.
 */

type QueryKeyInput = MaybeRef<QueryKey>;

/**
 * Resolves a key to plain values before it reaches the core.
 *
 * Refs are unwrapped at any depth, not just the top level: keys are written
 * inline at call sites (`["documents", spaceId, { filter }]`) and a ref can sit
 * anywhere in that structure. The core deliberately knows nothing about them.
 */
function deepUnwrap(value: unknown): unknown {
  if (isRef(value)) return deepUnwrap(value.value);
  if (Array.isArray(value)) return value.map(deepUnwrap);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepUnwrap(item)]),
    );
  }
  return value;
}

function resolveKey(queryKey: QueryKeyInput): QueryKey {
  return [...toValue(queryKey)].map(deepUnwrap);
}

function queryHash(queryKey: QueryKeyInput): string {
  return hashResolvedKey(resolveKey(queryKey));
}

/**
 * The Vue-facing cache handle.
 *
 * Identical surface to before the core split, so every call site is unchanged;
 * it resolves `MaybeRef` keys and delegates.
 */
export class QueryClient {
  private readonly cache: QueryCache;

  constructor(options: QueryCacheOptions = {}) {
    this.cache = new QueryCache(options);
  }

  getDefaultOptions(): QueryDefaults {
    return this.cache.getDefaultOptions();
  }

  getEntry<T>(queryKey: QueryKeyInput): QueryEntry<T> {
    return this.cache.getEntry<T>(resolveKey(queryKey));
  }

  setQueryData<T>(
    queryKey: QueryKeyInput,
    updater: QueryDataUpdater<T>,
    options?: { stale?: boolean },
  ): void {
    this.cache.setQueryData(resolveKey(queryKey), updater, options);
  }

  getQueryData<T>(queryKey: QueryKeyInput): T | undefined {
    return this.cache.getQueryData<T>(resolveKey(queryKey));
  }

  invalidateQueries(options: { queryKey: QueryKeyInput }): void {
    this.cache.invalidateQueries({ queryKey: resolveKey(options.queryKey) });
  }

  removeEntry(hash: string): void {
    this.cache.removeEntry(hash);
  }
}

interface UseQueryOptions<TData> {
  enabled?: MaybeRef<boolean>;
  /** Hydrates an otherwise empty query before its network request resolves. */
  initialData?: () => Promise<TData | undefined>;
  placeholderData?: (previousData: TData | undefined) => TData | undefined;
  queryFn: () => Promise<TData>;
  queryKey: QueryKeyInput;
  /** Receives authoritative and optimistic updates from an external data source. */
  subscribe?: (callback: (data: TData | undefined) => void) => () => void;
  staleTime?: number;
}

interface UseMutationOptions<TData, TVariables, TContext> {
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

interface UseInfiniteQueryOptions<TPage, TPageParam> {
  enabled?: MaybeRef<boolean>;
  getNextPageParam: (lastPage: TPage, allPages: TPage[]) => TPageParam | undefined;
  initialPageParam: TPageParam;
  queryFn: (context: { pageParam: TPageParam }) => Promise<TPage>;
  queryKey: QueryKeyInput;
  staleTime?: number;
}

export interface InfiniteData<TPage, TPageParam = unknown> {
  pages: TPage[];
  pageParams: TPageParam[];
}

function resolveEnabled(enabled: MaybeRef<boolean> | undefined): boolean {
  return enabled === undefined ? true : toValue(enabled);
}

let activeQueryClient = new QueryClient();
const QUERY_CLIENT_KEY: InjectionKey<QueryClient> = Symbol("query-client");

export const QueryPlugin = {
  install(app: App, options?: { queryClient?: QueryClient }) {
    const queryClient = options?.queryClient ?? new QueryClient();

    // Vue creates a separate app for each Astro island. Providing the client
    // keeps SSR renders isolated even when multiple requests render at once.
    if (typeof app.provide === "function") {
      app.provide(QUERY_CLIENT_KEY, queryClient);
    } else {
      // Retain the non-component fallback for effect-scope consumers and tests.
      activeQueryClient = queryClient;
    }
  },
};

export function useQueryClient(): QueryClient {
  return getCurrentInstance()
    ? inject(QUERY_CLIENT_KEY, activeQueryClient)
    : activeQueryClient;
}

export function useQuery<TData = unknown>(options: UseQueryOptions<TData>) {
  const queryClient = useQueryClient();
  const data = shallowRef<TData | undefined>(undefined);
  const error = shallowRef<Error | null>(null);
  const hasData = ref(false);
  const isFetching = ref(false);
  const isEnabled = ref(false);

  let currentEntry: QueryEntry<TData> | null = null;
  let currentObserver: (() => void) | null = null;
  let currentFetcher: (() => Promise<unknown>) | null = null;
  let currentDataSubscription: (() => void) | null = null;
  let hasPlaceholder = false;
  let placeholderData: TData | undefined;
  let previousData: TData | undefined;

  const cleanup = () => {
    if (!currentEntry) return;

    if (currentObserver) {
      currentEntry.observers.delete(currentObserver);
    }
    if (currentFetcher) {
      currentEntry.fetchers.delete(currentFetcher);
    }
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
          if (entry.observers.size === 0) {
            queryClient.removeEntry(entry.hash);
          }
        }, gcTime);
      }
    }
  };

  const attach = () => {
    const enabled = resolveEnabled(options.enabled);
    const entry = queryClient.getEntry<TData>(options.queryKey);
    const hadCachedData = entry.hasData;

    if (entry.gcTimer) {
      clearTimeout(entry.gcTimer);
      entry.gcTimer = null;
    }

    entry.queryFn = options.queryFn;
    entry.staleTime = options.staleTime ?? queryClient.getDefaultOptions().staleTime ?? 0;
    currentEntry = entry;
    isEnabled.value = enabled;
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
        data.value = entry.data;
        hasData.value = true;
      } else if (hasPlaceholder) {
        data.value = placeholderData;
        hasData.value = true;
      } else {
        data.value = undefined;
        hasData.value = false;
      }
      error.value = entry.error;
      isFetching.value = entry.isFetching;
    };

    currentFetcher = async () => {
      if (!resolveEnabled(options.enabled)) return undefined;
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
          queryClient.setQueryData(options.queryKey, initialData);
        })
        .catch(() => undefined);
    }

    if (options.subscribe) {
      currentDataSubscription = options.subscribe((nextData) => {
        if (entry !== currentEntry || nextData === undefined) return;
        queryClient.setQueryData(options.queryKey, nextData);
      });
    }

    if (enabled) {
      void fetchEntry(entry).catch(() => undefined);
    }
  };

  watch(
    () => [queryHash(options.queryKey), resolveEnabled(options.enabled)] as const,
    () => {
      previousData = data.value;
      cleanup();
      attach();
    },
    { immediate: true },
  );

  onScopeDispose(cleanup);

  const isPending = computed(() => isEnabled.value && !hasData.value && isFetching.value);
  const isError = computed(() => error.value !== null);

  const refetch = async () => {
    if (!currentEntry) return undefined;
    return await fetchEntry(currentEntry, true).catch(() => undefined);
  };

  return {
    data,
    error,
    isError,
    isFetching,
    isLoading: isPending,
    isPending,
    refetch,
  };
}

export function useMutation<TData = unknown, TVariables = void, TContext = unknown>(
  options: UseMutationOptions<TData, TVariables, TContext>,
) {
  const data = shallowRef<TData | undefined>(undefined);
  const error = shallowRef<Error | null>(null);
  const isPending = ref(false);

  const mutateAsync = async (variables: TVariables): Promise<TData> => {
    let context: TContext | undefined;
    isPending.value = true;
    error.value = null;

    try {
      context = await options.onMutate?.(variables);
      const result = await options.mutationFn(variables);
      data.value = result;
      await options.onSuccess?.(result, variables, context);
      await options.onSettled?.(result, null, variables, context);
      return result;
    } catch (rawError) {
      const mutationError = toError(rawError);
      error.value = mutationError;
      await options.onError?.(mutationError, variables, context);
      await options.onSettled?.(undefined, mutationError, variables, context);
      throw mutationError;
    } finally {
      isPending.value = false;
    }
  };

  const mutate = (variables: TVariables): void => {
    void mutateAsync(variables).catch(() => undefined);
  };

  return {
    data,
    error,
    isError: computed(() => error.value !== null),
    isPending,
    mutate,
    mutateAsync,
  };
}

/**
 * Accumulating pagination: every fetched page stays in `data.pages`, and
 * `fetchNextPage` appends. For load-more and infinite-scroll lists.
 *
 * **Pick this or `useCursorPagedList`?** That one (in `useCursorPagedList.ts`)
 * is a *pager* — one page visible at a time, with `prevPage`/`nextPage`
 * replacing it. This one only moves forward and never drops what it has.
 * Choose by the UI you want, not by the endpoint: both sit on the same
 * `useQuery` cache, the same endpoint is read both ways where two views want
 * different shapes, and one view showing two lists may need both.
 */
export function useInfiniteQuery<TPage, TPageParam = unknown>(
  options: UseInfiniteQueryOptions<TPage, TPageParam>,
) {
  const isFetchingNextPage = ref(false);
  const queryClient = useQueryClient();

  const query = useQuery<InfiniteData<TPage, TPageParam>>({
    enabled: options.enabled,
    queryKey: options.queryKey,
    queryFn: async () => {
      const firstPage = await options.queryFn({
        pageParam: options.initialPageParam,
      });
      return {
        pageParams: [options.initialPageParam],
        pages: [firstPage],
      };
    },
    staleTime: options.staleTime,
  });

  const hasNextPage = computed(() => {
    const current = query.data.value;
    if (!current || current.pages.length === 0) return false;

    const nextPageParam = options.getNextPageParam(
      current.pages[current.pages.length - 1],
      current.pages,
    );

    return nextPageParam !== undefined;
  });

  const fetchNextPage = async () => {
    const current = query.data.value;
    if (!current || current.pages.length === 0 || isFetchingNextPage.value) {
      return;
    }

    const nextPageParam = options.getNextPageParam(
      current.pages[current.pages.length - 1],
      current.pages,
    );

    if (nextPageParam === undefined) return;

    isFetchingNextPage.value = true;
    try {
      const nextPage = await options.queryFn({ pageParam: nextPageParam });
      queryClient.setQueryData<InfiniteData<TPage, TPageParam>>(
        options.queryKey,
        (old) => ({
          pageParams: [...(old?.pageParams ?? []), nextPageParam],
          pages: [...(old?.pages ?? []), nextPage],
        }),
      );
    } catch (rawError) {
      query.error.value = toError(rawError);
    } finally {
      isFetchingNextPage.value = false;
    }
  };

  return {
    ...query,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  };
}
