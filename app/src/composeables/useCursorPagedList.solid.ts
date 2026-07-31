import {
  type Accessor,
  createMemo,
  createRenderEffect,
  createSignal,
  on,
} from "solid-js";
import type { MaybeAccessor } from "./query.solid.ts";
import { useQuery } from "./query.solid.ts";
import { type QueryKey, queryHash } from "./queryCore.ts";

export interface CursorPagedListOptions<T> {
  /**
   * Base query key used for cache namespacing.
   * Pagination params are appended automatically, so keys like `["job_runs",
   * spaceId]` or `() => ["search", spaceId(), query()]` work correctly.
   */
  queryKey: MaybeAccessor<QueryKey>;

  /**
   * Fetches one page. Returns `{ items, nextCursor }`, where `nextCursor` is
   * the opaque cursor for the next page, or `null` on the last one.
   */
  fetcher: (params: {
    limit: number;
    cursor?: string;
  }) => Promise<{ items: T[]; nextCursor: string | null }>;

  /** @default 20 */
  pageSize?: number;

  /**
   * Controls whether the query runs. Useful when the composable depends on a
   * value that may not be ready yet (e.g. `() => !!spaceId()`).
   * @default true
   */
  enabled?: MaybeAccessor<boolean>;
}

export interface CursorPagedListResult<T> {
  /** Current page of items (empty while loading). */
  items: Accessor<T[]>;
  /** True while the initial page load is in flight. */
  isLoading: Accessor<boolean>;
  /** True while any fetch, including background revalidation, is in flight. */
  isFetching: Accessor<boolean>;
  /** The last error thrown by the fetcher, or null. */
  error: Accessor<Error | null>;
  hasPrevPage: Accessor<boolean>;
  hasNextPage: Accessor<boolean>;
  /** Advance to the next page (no-op on the last page). */
  nextPage: () => void;
  /** Go back to the previous page (no-op on the first page). */
  prevPage: () => void;
  /** Re-fetch the current page, bypassing the cache. */
  refresh: () => void;
}

/**
 * Cursor-based paged listing, Solid.
 *
 * **Pick this or `useInfiniteQuery`?** This one is a *pager*: one page is
 * visible at a time and `prevPage`/`nextPage` replace it. `useInfiniteQuery`
 * *accumulates* pages for load-more lists and only moves forward. Choose by the
 * UI you want, not by the endpoint — both sit on the same `useQuery` cache, the
 * same endpoint is read both ways where two views want different shapes, and
 * one view showing two lists may need both.
 *
 * Unlike offset paging, cursor paging only moves sequentially — there is no
 * jump-to-page-N and no total count. Cursors for pages already visited are kept
 * client-side, so `prevPage` is one hop rather than a re-walk from the start.
 */
export function useCursorPagedList<T>(
  options: CursorPagedListOptions<T>,
): CursorPagedListResult<T> {
  const { fetcher, pageSize = 20, enabled, queryKey } = options;
  const baseKey = () =>
    typeof queryKey === "function" ? (queryKey as Accessor<QueryKey>)() : queryKey;

  // cursors()[i] is the cursor used to fetch page i; index 0 is always
  // undefined (the first page).
  const [cursors, setCursors] = createSignal<(string | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = createSignal(0);
  const currentCursor = createMemo(() => cursors()[pageIndex()]);

  // Pagination params go in the cache key so each page is cached independently
  // and a page change triggers its own fetch.
  const fullQueryKey = () => [...baseKey(), { limit: pageSize, cursor: currentCursor() }];

  const query = useQuery<{ items: T[]; nextCursor: string | null }>({
    queryKey: fullQueryKey,
    queryFn: () => fetcher({ limit: pageSize, cursor: currentCursor() }),
    enabled: () =>
      enabled !== undefined
        ? typeof enabled === "function"
          ? enabled()
          : enabled
        : true,
    // Keep the previous page visible while the next one loads, so the list
    // never blanks between pages.
    placeholderData: (previous) => previous,
  });

  // Back to page one whenever the *base* key changes — a space switch or a new
  // search term — so the reader never lands on a cursor from another list.
  //
  // Compared by hash rather than identity: the key is usually rebuilt inline on
  // every read, so identity always differs. `defer` skips the initial run,
  // which is what Vue's non-immediate `watch` gave.
  // A memo, because `on` re-runs its body whenever a tracked dependency
  // notifies and never compares the value it read. The memo is what turns
  // "the key was rebuilt" into "the key actually changed".
  const baseKeyHash = createMemo(() => queryHash(baseKey()));

  createRenderEffect(
    on(
      baseKeyHash,
      () => {
        setCursors([undefined]);
        setPageIndex(0);
      },
      { defer: true },
    ),
  );

  return {
    items: createMemo(() => query.data()?.items ?? []),
    isLoading: query.isPending,
    isFetching: query.isFetching,
    error: query.error,
    hasPrevPage: createMemo(() => pageIndex() > 0),
    hasNextPage: createMemo(() => Boolean(query.data()?.nextCursor)),
    nextPage: () => {
      const next = query.data()?.nextCursor;
      if (!next) return;
      const index = pageIndex();
      // Replaced, not mutated: a push would not notify.
      if (index + 1 >= cursors().length) setCursors((list) => [...list, next]);
      setPageIndex(index + 1);
    },
    prevPage: () => setPageIndex((index) => (index > 0 ? index - 1 : index)),
    refresh: () => {
      void query.refetch();
    },
  };
}
