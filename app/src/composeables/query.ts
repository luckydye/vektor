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

type QueryKey = readonly unknown[];
type QueryKeyInput = MaybeRef<QueryKey>;
type QueryDataUpdater<T> = T | ((old: T | undefined) => T | undefined);

interface QueryDefaults {
  gcTime?: number;
  staleTime?: number;
}

interface QueryClientOptions {
  defaultOptions?: {
    queries?: QueryDefaults;
  };
}

interface QueryEntry<T = unknown> {
  data: ShallowRef<T | undefined>;
  error: ShallowRef<Error | null>;
  fetchers: Set<() => Promise<unknown>>;
  gcTimer: ReturnType<typeof setTimeout> | null;
  hasData: Ref<boolean>;
  hash: string;
  isFetching: Ref<boolean>;
  key: unknown[];
  observers: Set<() => void>;
  promise: Promise<T> | null;
  queryFn: (() => Promise<T>) | null;
  staleTime: number;
  updatedAt: number;
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

function normalizeForKey(value: unknown): unknown {
  if (isRef(value)) {
    return normalizeForKey(value.value);
  }

  if (value === undefined) {
    return { __type: "undefined" };
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeForKey);
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalizeForKey(item)]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForKey(value));
}

function resolveQueryKey(queryKey: QueryKeyInput): unknown[] {
  return [...toValue(queryKey)].map(normalizeForKey);
}

function queryHash(queryKey: QueryKeyInput): string {
  return stableStringify(resolveQueryKey(queryKey));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function keysMatch(key: unknown[], prefix: unknown[]): boolean {
  if (prefix.length > key.length) return false;

  return prefix.every(
    (part, index) => stableStringify(part) === stableStringify(key[index]),
  );
}

function resolveEnabled(enabled: MaybeRef<boolean> | undefined): boolean {
  return enabled === undefined ? true : toValue(enabled);
}

export class QueryClient {
  private readonly cache = new Map<string, QueryEntry>();
  private readonly defaultOptions: QueryDefaults;

  constructor(options: QueryClientOptions = {}) {
    this.defaultOptions = options.defaultOptions?.queries ?? {};
  }

  getDefaultOptions(): QueryDefaults {
    return this.defaultOptions;
  }

  getEntry<T>(queryKey: QueryKeyInput): QueryEntry<T> {
    const key = resolveQueryKey(queryKey);
    const hash = stableStringify(key);
    const existing = this.cache.get(hash) as QueryEntry<T> | undefined;

    if (existing) {
      return existing;
    }

    const entry: QueryEntry<T> = {
      data: shallowRef<T | undefined>(undefined),
      error: shallowRef<Error | null>(null),
      fetchers: new Set(),
      gcTimer: null,
      hasData: ref(false),
      hash,
      isFetching: ref(false),
      key,
      observers: new Set(),
      promise: null,
      queryFn: null,
      staleTime: this.defaultOptions.staleTime ?? 0,
      updatedAt: 0,
    };

    this.cache.set(hash, entry as QueryEntry);
    return entry;
  }

  setQueryData<T>(
    queryKey: QueryKeyInput,
    updater: QueryDataUpdater<T>,
    options?: { stale?: boolean },
  ): void {
    const entry = this.getEntry<T>(queryKey);
    const nextData =
      typeof updater === "function"
        ? (updater as (old: T | undefined) => T | undefined)(entry.data.value)
        : updater;

    entry.data.value = nextData;
    entry.hasData.value = true;
    entry.error.value = null;
    entry.updatedAt = options?.stale ? 0 : Date.now();
    notify(entry);
  }

  getQueryData<T>(queryKey: QueryKeyInput): T | undefined {
    return this.getEntry<T>(queryKey).data.value;
  }

  invalidateQueries(options: { queryKey: QueryKeyInput }): void {
    const prefix = resolveQueryKey(options.queryKey);

    for (const entry of this.cache.values()) {
      if (!keysMatch(entry.key, prefix)) continue;

      entry.updatedAt = 0;
      for (const fetch of entry.fetchers) {
        void fetch();
      }
    }
  }

  removeEntry(hash: string): void {
    this.cache.delete(hash);
  }
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

function notify(entry: QueryEntry): void {
  for (const observer of entry.observers) {
    observer();
  }
}

function isFresh(entry: QueryEntry): boolean {
  return entry.hasData.value && Date.now() - entry.updatedAt < entry.staleTime;
}

async function fetchEntry<T>(
  entry: QueryEntry<T>,
  force = false,
): Promise<T | undefined> {
  if (!force && isFresh(entry)) {
    return entry.data.value;
  }

  if (!entry.queryFn) {
    return entry.data.value;
  }

  if (entry.promise) {
    return entry.promise;
  }

  entry.isFetching.value = true;
  notify(entry);

  entry.promise = entry
    .queryFn()
    .then((result) => {
      entry.data.value = result;
      entry.hasData.value = true;
      entry.error.value = null;
      entry.updatedAt = Date.now();
      return result;
    })
    .catch((error: unknown) => {
      entry.error.value = toError(error);
      throw entry.error.value;
    })
    .finally(() => {
      entry.isFetching.value = false;
      entry.promise = null;
      notify(entry);
    });

  notify(entry);
  return entry.promise;
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
    const hadCachedData = entry.hasData.value;

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
      if (entry.hasData.value) {
        hasPlaceholder = false;
        placeholderData = undefined;
        data.value = entry.data.value;
        hasData.value = true;
      } else if (hasPlaceholder) {
        data.value = placeholderData;
        hasData.value = true;
      } else {
        data.value = undefined;
        hasData.value = false;
      }
      error.value = entry.error.value;
      isFetching.value = entry.isFetching.value;
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
          if (entry !== currentEntry || entry.hasData.value || initialData === undefined)
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
