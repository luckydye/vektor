import {
  type ComputedRef,
  computed,
  type MaybeRef,
  type Ref,
  ref,
  toValue,
  watch,
} from "vue";
import { useQuery } from "./query.ts";

export interface CursorPagedListOptions<T> {
  /**
   * Base query key used for cache namespacing.
   * Pagination params are appended automatically, so keys like
   * `["job_runs", spaceId]` or `computed(() => ["search", spaceId, query])`
   * work correctly.
   */
  queryKey: MaybeRef<unknown[]>;

  /**
   * Async function that fetches one page of results.
   * Must return `{ items, nextCursor }`, where `nextCursor` is the opaque
   * cursor to pass back in to fetch the next page, or `null` on the last page.
   */
  fetcher: (params: {
    limit: number;
    cursor?: string;
  }) => Promise<{ items: T[]; nextCursor: string | null }>;

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

export interface CursorPagedListResult<T> {
  /** Current page of items (empty array while loading). */
  items: ComputedRef<T[]>;
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
  /** Advance to the next page (no-op on the last page). */
  nextPage: () => void;
  /** Go back to the previous page (no-op on the first page). */
  prevPage: () => void;
  /** Re-fetch the current page, bypassing the cache. */
  refresh: () => void;
}

/**
 * Generic composable for cursor-based paged listings.
 *
 * **Pick this or `useInfiniteQuery`?** This one is a *pager*: one page is
 * visible at a time and `prevPage`/`nextPage` replace it. `useInfiniteQuery`
 * (in `query.ts`) *accumulates* pages for load-more lists and only moves
 * forward. Choose by the UI you want, not by the endpoint — both sit on the
 * same `useQuery` cache, the same endpoint is read both ways where two views
 * want different shapes, and one view showing two lists may need both.
 *
 * Unlike offset paging, cursor paging only supports moving sequentially
 * (previous/next) — there's no jump-to-page-N or total count. Cursors for
 * pages already visited are cached client-side so `prevPage` doesn't refetch.
 *
 * @example
 * // Run history
 * const { items: runs, ...pagination } = useCursorPagedList({
 *   queryKey: computed(() => ["job_runs", spaceId.value]),
 *   fetcher: ({ limit, cursor }) =>
 *     api.jobs.listRuns(spaceId.value!, { limit, cursor }).then(r => ({
 *       items: r.runs,
 *       nextCursor: r.nextCursor,
 *     })),
 *   enabled: computed(() => !!spaceId.value),
 * });
 */
export function useCursorPagedList<T>(
  options: CursorPagedListOptions<T>,
): CursorPagedListResult<T> {
  const { fetcher, pageSize = 20, enabled, queryKey } = options;

  // cursors[i] is the cursor used to fetch page i; cursors[0] is always
  // undefined (first page).
  const cursors = ref<(string | undefined)[]>([undefined]);
  const pageIndex = ref(0);
  const currentCursor = computed(() => cursors.value[pageIndex.value]);

  // Include pagination params in the cache key so each page is cached
  // independently and page transitions trigger automatic re-fetches.
  const fullQueryKey = computed(() => [
    ...toValue(queryKey),
    { limit: pageSize, cursor: currentCursor.value },
  ]);

  const {
    data,
    isPending: isLoading,
    isFetching,
    error: rawError,
    refetch,
  } = useQuery({
    queryKey: fullQueryKey,
    queryFn: () => fetcher({ limit: pageSize, cursor: currentCursor.value }),
    enabled: computed(() => (enabled !== undefined ? toValue(enabled) : true)),
    // Keep previous page data visible while the next page loads so the UI
    // doesn't flash an empty state between pages.
    placeholderData: (prev) => prev,
  });

  const items = computed<T[]>(() => data.value?.items ?? []);
  const hasPrevPage = computed(() => pageIndex.value > 0);
  const hasNextPage = computed(() => !!data.value?.nextCursor);

  // Reset to the first page whenever the base query key changes (e.g. space
  // switch, new search query) so the user doesn't land on a stale cursor.
  watch(
    () => toValue(queryKey),
    () => {
      cursors.value = [undefined];
      pageIndex.value = 0;
    },
    { deep: true },
  );

  function nextPage(): void {
    const next = data.value?.nextCursor;
    if (!next) return;
    if (pageIndex.value + 1 >= cursors.value.length) {
      cursors.value.push(next);
    }
    pageIndex.value++;
  }

  function prevPage(): void {
    if (pageIndex.value > 0) pageIndex.value--;
  }

  function refresh(): void {
    refetch();
  }

  return {
    items,
    isLoading: isLoading as unknown as Ref<boolean>,
    isFetching: isFetching as unknown as Ref<boolean>,
    error: rawError as unknown as Ref<Error | null>,
    hasPrevPage,
    hasNextPage,
    nextPage,
    prevPage,
    refresh,
  };
}
