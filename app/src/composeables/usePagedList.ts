import { useQuery } from "@tanstack/vue-query";
import {
  type ComputedRef,
  computed,
  type MaybeRef,
  type Ref,
  ref,
  toValue,
  watch,
} from "vue";

export interface PagedListOptions<T> {
  /**
   * Base query key used for cache namespacing.
   * Pagination params are appended automatically, so keys like
   * `["job_runs", spaceId]` or `computed(() => ["search", spaceId, query])`
   * work correctly.
   */
  queryKey: MaybeRef<unknown[]>;

  /**
   * Async function that fetches one page of results.
   * Must return `{ items, total }` where `total` is the full un-paged count.
   */
  fetcher: (params: {
    limit: number;
    offset: number;
  }) => Promise<{ items: T[]; total: number }>;

  /**
   * Number of items per page.
   * @default 20
   */
  pageSize?: number;

  /**
   * Controls whether the query runs.
   * Useful when the composable depends on a value that may not be ready yet
   * (e.g. `computed(() => !!spaceId.value)`).
   * @default true
   */
  enabled?: MaybeRef<boolean>;
}

export interface PagedListResult<T> {
  /** Current page of items (empty array while loading). */
  items: ComputedRef<T[]>;
  /** Total number of items across all pages. */
  total: ComputedRef<number>;
  /** Current 1-based page number. */
  page: Ref<number>;
  /** Total number of pages given the current `total` and `pageSize`. */
  totalPages: ComputedRef<number>;
  /** 0-based offset of the first item on the current page. */
  offset: ComputedRef<number>;
  /** True while the initial page load is in flight. */
  isLoading: Ref<boolean>;
  /** True while any fetch (including background re-fetches) is in flight. */
  isFetching: Ref<boolean>;
  /** The last error thrown by the fetcher, or null. */
  error: Ref<Error | null>;
  /** Whether a previous page exists. */
  hasPrevPage: ComputedRef<boolean>;
  /** Whether a next page exists. */
  hasNextPage: ComputedRef<boolean>;
  /** Navigate to an arbitrary 1-based page number (clamped to valid range). */
  goToPage: (page: number) => void;
  /** Advance to the next page (no-op on the last page). */
  nextPage: () => void;
  /** Go back to the previous page (no-op on the first page). */
  prevPage: () => void;
  /** Re-fetch the current page, bypassing the cache. */
  refresh: () => void;
}

/**
 * Generic composable for offset-based paged listings.
 *
 * @example
 * // Run history
 * const { items: runs, ...pagination } = usePagedList({
 *   queryKey: computed(() => ["job_runs", spaceId.value]),
 *   fetcher: ({ limit, offset }) =>
 *     api.jobs.listRuns(spaceId.value!, { limit, offset }).then(r => ({
 *       items: r.runs,
 *       total: r.total,
 *     })),
 *   enabled: computed(() => !!spaceId.value),
 * });
 *
 * @example
 * // Archived documents
 * const { items: docs, ...pagination } = usePagedList({
 *   queryKey: computed(() => ["archived_docs", spaceId]),
 *   fetcher: ({ limit, offset }) =>
 *     api.documents.archived(spaceId, { limit, offset }).then(r => ({
 *       items: r.documents,
 *       total: r.total,
 *     })),
 * });
 *
 * @example
 * // Search results
 * const { items: results, ...pagination } = usePagedList({
 *   queryKey: computed(() => ["search", spaceId, query.value, filters.value]),
 *   fetcher: ({ limit, offset }) =>
 *     api.search.get(spaceId, { q: query.value, limit, offset }).then(r => ({
 *       items: r.results,
 *       total: r.total,
 *     })),
 *   enabled: computed(() => query.value.trim().length > 0),
 *   pageSize: 20,
 * });
 */
export function usePagedList<T>(options: PagedListOptions<T>): PagedListResult<T> {
  const { fetcher, pageSize = 20, enabled, queryKey } = options;

  const page = ref(1);
  const offset = computed(() => (page.value - 1) * pageSize);

  // Include pagination params in the cache key so each page is cached
  // independently and page transitions trigger automatic re-fetches.
  const fullQueryKey = computed(() => [
    ...toValue(queryKey),
    { limit: pageSize, offset: offset.value },
  ]);

  const {
    data,
    isPending: isLoading,
    isFetching,
    error: rawError,
    refetch,
  } = useQuery({
    queryKey: fullQueryKey,
    queryFn: () => fetcher({ limit: pageSize, offset: offset.value }),
    enabled: computed(() => (enabled !== undefined ? toValue(enabled) : true)),
    // Keep previous page data visible while the next page loads so the UI
    // doesn't flash an empty state between pages.
    placeholderData: (prev) => prev,
  });

  const items = computed<T[]>(() => data.value?.items ?? []);
  const total = computed(() => data.value?.total ?? 0);
  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
  const hasPrevPage = computed(() => page.value > 1);
  const hasNextPage = computed(() => page.value < totalPages.value);

  // Reset to page 1 whenever the base query key changes (e.g. space switch,
  // new search query) so the user doesn't land on a now-invalid page.
  watch(
    () => toValue(queryKey),
    () => {
      page.value = 1;
    },
    { deep: true },
  );

  function goToPage(target: number): void {
    const clamped = Math.max(1, Math.min(target, totalPages.value));
    page.value = clamped;
  }

  function nextPage(): void {
    if (hasNextPage.value) page.value++;
  }

  function prevPage(): void {
    if (hasPrevPage.value) page.value--;
  }

  function refresh(): void {
    refetch();
  }

  return {
    items,
    total,
    page,
    totalPages,
    offset,
    isLoading: isLoading as unknown as Ref<boolean>,
    isFetching: isFetching as unknown as Ref<boolean>,
    error: rawError as unknown as Ref<Error | null>,
    hasPrevPage,
    hasNextPage,
    goToPage,
    nextPage,
    prevPage,
    refresh,
  };
}
