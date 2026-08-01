import { useLocation, useNavigate } from "@solidjs/router";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { DocumentWithProperties } from "#api/client.ts";
import { api, type PropertyFilter } from "#api/client.ts";
import { useInfiniteQuery } from "#composeables/query.ts";
import { useCursorPagedList } from "#composeables/useCursorPagedList.ts";
import { canEdit } from "#composeables/usePermissions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { DocumentGroupedList } from "./DocumentGroupedList.tsx";
import { Icon } from "./Icon.tsx";
import { PagerCursor } from "./PagerCursor.tsx";
import { SearchFilters } from "./SearchFilters.tsx";

interface Props {
  spaceId: string;
}

export function Search(props: Props) {
  const { currentSpace } = useSpace();
  const navigate = useNavigate();
  const location = useLocation();
  const userCanEdit = createMemo(() => canEdit(currentSpace()?.userRole));

  const [searchQuery, setSearchQuery] = createSignal("");
  const [activeFilters, setActiveFilters] = createSignal<PropertyFilter[]>([]);
  const [hasSearched, setHasSearched] = createSignal(false);

  // "Committed" values — only updated when the user explicitly submits a search.
  // This prevents the paged list from re-fetching while the user is still typing.
  const [committedQuery, setCommittedQuery] = createSignal("");
  const [committedFilters, setCommittedFilters] = createSignal<PropertyFilter[]>([]);

  const {
    items: results,
    isLoading: isSearching,
    isFetching: isFetchingSearch,
    error: searchError,
    hasPrevPage: hasPrevSearchPage,
    hasNextPage: hasNextSearchPage,
    nextPage: nextSearchPage,
    prevPage: prevSearchPage,
  } = useCursorPagedList({
    queryKey: createMemo(() => [
      "search",
      props.spaceId,
      committedQuery(),
      JSON.stringify(committedFilters()),
    ]),
    fetcher: ({ limit, cursor }) => {
      const queryParams: {
        q?: string;
        limit: number;
        cursor?: string;
        filters?: string;
      } = { limit, cursor };
      if (committedQuery().trim()) queryParams.q = committedQuery();
      if (committedFilters().length > 0) {
        queryParams.filters = JSON.stringify(committedFilters());
      }
      return api.search.get(props.spaceId, queryParams).then((r) => ({
        items: r.results,
        nextCursor: r.nextCursor,
      }));
    },
    enabled: hasSearched,
    pageSize: 20,
  });

  const sortedResults = createMemo(() => [...results()].sort((a, b) => a.rank - b.rank));

  const updateUrlParams = () => {
    const query = new URLSearchParams(location.search);
    if (searchQuery().trim()) query.set("q", searchQuery());
    else query.delete("q");
    if (activeFilters().length > 0) {
      query.set("filters", JSON.stringify(activeFilters()));
    } else {
      query.delete("filters");
    }
    const search = query.toString();
    // `location.pathname` already carries the router base ("/{space}/"), so the
    // target must not be resolved against it again — that yields "/space/space/…".
    navigate(`${location.pathname}${search ? `?${search}` : ""}`, {
      replace: true,
      resolve: false,
    });
  };

  // Infinite query for documents (when not searching)
  const documentsPageSize = 50;

  const {
    data: documentsData,
    fetchNextPage,
    hasNextPage: hasMoreDocuments,
    isFetchingNextPage,
    isLoading: isLoadingDocuments,
  } = useInfiniteQuery({
    queryKey: createMemo(() => ["documents", props.spaceId]),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) =>
      await api.documents.get(props.spaceId, {
        limit: documentsPageSize,
        cursor: pageParam,
        // The browse list stands in for search with no query, so it lists
        // uploads next to documents the way a search result set does.
        includeFiles: true,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined,
  });

  // Flatten all documents from pages (only when not searching)
  const allDocuments = createMemo(() => {
    if (hasSearched()) return [];
    return documentsData()?.pages.flatMap((page) => page.documents) ?? [];
  });

  const handleScroll = () => {
    if (hasSearched()) return;
    if (isFetchingNextPage() || !hasMoreDocuments()) return;

    const scrollPosition = window.innerHeight + window.scrollY;
    const threshold = document.documentElement.scrollHeight - 500;

    if (scrollPosition >= threshold) fetchNextPage();
  };

  onMount(() => {
    window.addEventListener("scroll", handleScroll);
    onCleanup(() => window.removeEventListener("scroll", handleScroll));

    const urlParams = new URLSearchParams(window.location.search);
    const queryParam = urlParams.get("q");
    const filtersParam = urlParams.get("filters");

    if (queryParam) setSearchQuery(queryParam);

    if (filtersParam) {
      try {
        const parsed = JSON.parse(filtersParam);
        if (Array.isArray(parsed)) setActiveFilters(parsed);
      } catch {
        // Ignore invalid filters
      }
    }

    if (queryParam || filtersParam) {
      setCommittedQuery(queryParam ?? "");
      setCommittedFilters([...activeFilters()]);
      setHasSearched(true);
    }
  });

  const handleSearch = () => {
    const hasQuery = searchQuery().trim().length > 0;
    const hasFilters = activeFilters().length > 0;

    if (!hasQuery && !hasFilters) {
      setHasSearched(false);
      setCommittedQuery("");
      setCommittedFilters([]);
      updateUrlParams();
      return;
    }

    setCommittedQuery(searchQuery());
    setCommittedFilters([...activeFilters()]);
    setHasSearched(true);
    updateUrlParams();
  };

  const clear = () => {
    setSearchQuery("");
    setCommittedQuery("");
    if (activeFilters().length > 0) {
      setCommittedFilters([...activeFilters()]);
      setHasSearched(true);
    } else {
      setHasSearched(false);
      setCommittedFilters([]);
    }
    updateUrlParams();
  };

  const canSearch = createMemo(
    () => searchQuery().trim().length > 0 || activeFilters().length > 0,
  );

  // Batch operations
  const [isBatchArchiving, setIsBatchArchiving] = createSignal(false);
  const [batchError, setBatchError] = createSignal<string | null>(null);

  // Files (search results backed by the file table) aren't documents — their id
  // is a file storage path, not a document id, so they go through the uploads
  // delete endpoint instead of the document archive endpoint.
  const isFileId = (id: string) => {
    const item = [...sortedResults(), ...allDocuments()].find((d) => d.id === id);
    return item?.type === "file" || Boolean(item?.fileUrl);
  };

  const batchArchive = async (ids: string[]) => {
    setBatchError(null);
    if (ids.length === 0) return;

    const fileIds = ids.filter((id) => isFileId(id));
    const documentIds = ids.filter((id) => !isFileId(id));

    const parts: string[] = [];
    if (documentIds.length > 0) {
      parts.push(
        `archive ${documentIds.length} document${documentIds.length !== 1 ? "s" : ""}`,
      );
    }
    if (fileIds.length > 0) {
      parts.push(
        `permanently delete ${fileIds.length} file${fileIds.length !== 1 ? "s" : ""}`,
      );
    }
    if (!confirm(`${parts.join(" and ")}?`)) return;

    setIsBatchArchiving(true);
    const failed: string[] = [];

    for (const id of documentIds) {
      try {
        await api.document.archive(props.spaceId, id);
      } catch (error) {
        console.error("Failed to archive document", id, error);
        failed.push(id);
      }
    }

    for (const id of fileIds) {
      try {
        await api.upload.delete(props.spaceId, id);
      } catch (error) {
        console.error("Failed to delete file", id, error);
        failed.push(id);
      }
    }

    setIsBatchArchiving(false);

    if (failed.length > 0) {
      setBatchError(
        `Failed to process ${failed.length} of ${ids.length} item${ids.length !== 1 ? "s" : ""}.`,
      );
      return;
    }

    window.location.reload();
  };

  const batchActions = (selectedIds: Set<string>, deselectAll: () => void) => (
    <Show when={userCanEdit()}>
      <button
        type="button"
        onClick={() => {
          void batchArchive([...selectedIds]);
          deselectAll();
        }}
        disabled={isBatchArchiving()}
        class="rounded-md border border-neutral-200 px-3 py-1.5 font-medium text-neutral-700 text-size-small transition-colors hover:border-neutral-300 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isBatchArchiving() ? "Processing…" : "Archive / delete selected"}
      </button>
    </Show>
  );

  return (
    <div>
      {/* Search Box */}
      <div class="mb-3 flex gap-3">
        <div class="relative flex-1">
          <Icon
            class="pointer-events-none absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2 text-neutral-400"
            name="search"
          />
          <input
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
            type="text"
            placeholder="Find documents… (e.g. 'typescript', 'database design', 'react ui')"
            class="w-full rounded-lg border border-neutral-100 bg-background py-3 pr-12 pl-12 text-base focus:border-primary-300 focus:outline-none focus:ring-2 focus:ring-primary-100 disabled:cursor-not-allowed disabled:bg-neutral-100"
            onKeyDown={(event) => {
              if (event.key === "Enter") handleSearch();
            }}
            disabled={isSearching()}
          />
          <Show when={searchQuery()}>
            <button
              type="button"
              onClick={clear}
              class="absolute top-1/2 right-3 -translate-y-1/2 rounded-sm p-1 text-neutral hover:bg-neutral-100 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isSearching()}
              title="Clear search"
            >
              <Icon class="h-4 w-4" name="cancel" />
            </button>
          </Show>
        </div>

        <button
          type="button"
          onClick={handleSearch}
          disabled={isSearching() || !canSearch()}
          class="flex items-center gap-2 whitespace-nowrap rounded-lg bg-primary-500 px-5 py-3 font-medium text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Show
            when={!isSearching()}
            fallback={<Icon class="h-4 w-4 animate-spin" name="spinner" />}
          >
            <Icon class="h-4 w-4" name="search" />
          </Show>
          {isSearching() ? "Searching…" : "Search"}
        </button>
      </div>

      {/* Filter chips row */}
      <div class="mb-6">
        <SearchFilters
          spaceId={props.spaceId}
          value={activeFilters()}
          onInput={setActiveFilters}
          onSearch={handleSearch}
        />
      </div>

      <Show when={searchError()}>
        <div class="mb-6 flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-red-800 text-size-medium">
          <Icon class="h-5 w-5 shrink-0" name="alert-circle" />
          {searchError()?.message ?? "Search failed"}
        </div>
      </Show>

      <Show when={batchError()}>
        <div class="mb-6 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-800 text-size-medium">
          <Icon class="h-5 w-5 shrink-0" name="alert-circle" />
          {batchError()}
        </div>
      </Show>

      {/* Browse mode: grouped document list */}
      <Show when={!hasSearched()}>
        <Show when={allDocuments().length > 0}>
          <DocumentGroupedList
            items={allDocuments()}
            showToolbar={false}
            emptyText="No documents yet"
            batchActions={batchActions}
          />
        </Show>

        <Show when={hasMoreDocuments()}>
          <div class="mt-6 flex justify-center border-neutral-100 border-t pt-6">
            <button
              type="button"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage()}
              class="flex items-center gap-2 rounded-lg border border-neutral-100 bg-background px-5 py-2 font-medium text-size-medium transition-colors hover:border-primary-300 hover:text-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Show when={isFetchingNextPage()}>
                <Icon class="h-4 w-4 animate-spin" name="spinner" />
              </Show>
              {isFetchingNextPage() ? "Loading…" : "Load more"}
            </button>
          </div>
        </Show>

        <Show when={allDocuments().length === 0 && isLoadingDocuments()}>
          <div class="py-12 text-center">
            <Icon
              class="mx-auto mb-4 h-10 w-10 animate-spin text-neutral-300"
              name="spinner"
            />
            <p class="text-neutral-500 text-size-medium">Loading documents…</p>
          </div>
        </Show>

        <Show when={allDocuments().length === 0 && !isLoadingDocuments()}>
          <div class="py-12 text-center">
            <Icon class="mx-auto mb-4 h-12 w-12 text-neutral-300" name="document" />
            <h3 class="mb-2 font-semibold text-neutral-700 text-size-large">
              No documents yet
            </h3>
            <p class="text-neutral-500 text-size-medium">
              There are no documents in this space yet
            </p>
          </div>
        </Show>
      </Show>

      {/* Search results: grouped list */}
      <Show when={hasSearched() && sortedResults().length > 0}>
        <DocumentGroupedList
          items={sortedResults() as unknown as DocumentWithProperties[]}
          showToolbar={false}
          preserveOrder
          batchActions={batchActions}
        />

        <PagerCursor
          class="mt-6 pt-5"
          hasPrevPage={hasPrevSearchPage()}
          hasNextPage={hasNextSearchPage()}
          disabled={isFetchingSearch()}
          onPrev={prevSearchPage}
          onNext={nextSearchPage}
        />
      </Show>

      {/* No search results */}
      <Show
        when={
          hasSearched() &&
          sortedResults().length === 0 &&
          !isSearching() &&
          !searchError()
        }
      >
        <div class="py-12 text-center">
          <Icon class="mx-auto mb-4 h-12 w-12 text-neutral-300" name="search" />
          <h3 class="mb-2 font-semibold text-neutral-800 text-size-large">
            No results found
          </h3>
          <p class="mb-8 text-neutral-600">
            <Show
              when={searchQuery().trim()}
              fallback={<span>No documents match your filters</span>}
            >
              <span>
                No documents match <span class="font-semibold">"{searchQuery()}"</span>
              </span>
            </Show>
          </p>
        </div>
      </Show>
    </div>
  );
}
