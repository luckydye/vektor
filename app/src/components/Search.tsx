import { useLocation, useNavigate } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { canEdit } from "#acl/permissions.ts";
import type { DocumentWithProperties } from "#api/client.ts";
import { api, type PropertyFilter } from "#api/client.ts";
import { useInfiniteQuery, useQuery } from "#composeables/query.ts";
import { useCursorPagedList } from "#composeables/useCursorPagedList.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { brandTextColor } from "#utils/color.ts";
import { t } from "#utils/lang.ts";
import { DocumentGroupedList, type DocumentListItem } from "./DocumentGroupedList.tsx";
import { Icon } from "./Icon.tsx";
import { PagerCursor } from "./PagerCursor.tsx";
import { SearchFilters } from "./SearchFilters.tsx";
import { SpaceLogo } from "./SpaceLogo.tsx";

interface Props {
  spaceId: string;
}

/** The catalogue carries no plural rules, so each form is its own key. */
function countLabel(count: number, one: string, many: string): string {
  return t(count === 1 ? one : many).replace("{count}", String(count));
}

export function Search(props: Props) {
  const { currentSpace, spaces } = useSpace();
  const navigate = useNavigate();
  const location = useLocation();
  const userCanEdit = createMemo(() => canEdit(currentSpace()?.userRole));

  const [searchQuery, setSearchQuery] = createSignal("");
  const [activeFilters, setActiveFilters] = createSignal<PropertyFilter[]>([]);
  const [hasSearched, setHasSearched] = createSignal(false);

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

  // A second query rather than part of the paged one: what other spaces hold
  // does not change as the user pages through this space's results.
  const { data: otherSpaceResults } = useQuery({
    queryKey: createMemo(() => [
      "search-other-spaces",
      props.spaceId,
      committedQuery(),
      JSON.stringify(committedFilters()),
    ]),
    queryFn: () =>
      api.search.otherSpaces({
        q: committedQuery(),
        excludeSpaceId: props.spaceId,
        filters:
          committedFilters().length > 0 ? JSON.stringify(committedFilters()) : undefined,
      }),
    enabled: () => hasSearched() && committedQuery().trim().length > 0,
  });

  // How each space presents itself, from the listing the shell already holds —
  // the search results carry only which space they came from.
  const spaceBranding = createMemo(() => {
    const branding = new Map<string, { color?: string; logoSvg?: string }>();
    for (const space of spaces() ?? []) {
      branding.set(space.id, {
        color: space.preferences?.brandColor,
        logoSvg: space.preferences?.logoSvg,
      });
    }
    return branding;
  });

  // One list per space, best-matching space first, rather than five rows the
  // reader has to attribute one at a time.
  const otherSpaceGroups = createMemo(() => {
    const groups = new Map<
      string,
      {
        id: string;
        name: string;
        color?: string;
        logoSvg?: string;
        items: DocumentListItem[];
      }
    >();

    for (const result of otherSpaceResults() ?? []) {
      const group = groups.get(result.spaceId) ?? {
        id: result.spaceId,
        name: result.spaceName,
        ...spaceBranding().get(result.spaceId),
        items: [],
      };
      group.items.push(result as unknown as DocumentListItem);
      groups.set(result.spaceId, group);
    }

    return [...groups.values()];
  });

  // Only alongside the first page: below that the user is deep in this space's
  // results, and a hint they have already scrolled past is noise.
  const showOtherSpaces = createMemo(
    () => otherSpaceGroups().length > 0 && !hasPrevSearchPage(),
  );

  // The tinted panel carries what no single row can: everything inside it comes
  // from somewhere other than the space being searched.
  const otherSpacesSection = () => (
    <div class="my-5 rounded-xl bg-neutral-50 px-4 py-3.5">
      {/* A quiet caption, so the space names below it are the labels that carry
          this block: caption, then space, then document title. */}
      <div class="mb-4 flex items-center gap-2">
        <Icon class="h-3 w-3 text-neutral-400" name="folder" />
        <span class="font-medium text-neutral-500 text-size-extra-small">
          {t("Results in other Spaces you have access to")}
        </span>
        <div class="h-px flex-1 bg-neutral-200" />
      </div>

      {/* Each heading sits close to its own list and well clear of the next
          space's, so the grouping is read from the spacing alone. */}
      <div class="space-y-5">
        <For each={otherSpaceGroups()}>
          {(group) => (
            <div>
              <div class="mb-2 flex items-center gap-2">
                {/* The space's own mark, as the switcher shows it: the logo on its
                    brand colour. The name repeats it in words, for a space with no
                    mark of its own and for anyone who cannot tell them apart. */}
                <div
                  class="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-primary-500"
                  style={{ "background-color": group.color }}
                >
                  <SpaceLogo
                    logoSvg={group.logoSvg}
                    class="block h-full w-full object-contain"
                    fallbackClass="text-white [&>svg]:h-3 [&>svg]:w-3 [&>svg]:object-contain"
                  />
                </div>
                <span
                  class="truncate font-semibold text-primary-600 text-size-small"
                  style={{ color: brandTextColor(group.color) }}
                >
                  {group.name}
                </span>
                <span class="rounded-full bg-neutral-200 px-1.5 py-0.5 font-medium text-neutral-600 text-size-extra-small tabular-nums">
                  {group.items.length}
                </span>
              </div>

              <DocumentGroupedList
                items={group.items}
                flat
                selectable={false}
                showToolbar={false}
                preserveOrder
              />
            </div>
          )}
        </For>
      </div>
    </div>
  );

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
    navigate(`${location.pathname}${search ? `?${search}` : ""}`, {
      replace: true,
      resolve: false,
    });
  };

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
        includeFiles: true,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined,
  });

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
  });

  createEffect(
    on(
      () => location.search,
      () => {
        const urlParams = new URLSearchParams(location.search);
        const queryParam = urlParams.get("q");
        const filtersParam = urlParams.get("filters");

        let filters: PropertyFilter[] = [];
        if (filtersParam) {
          try {
            const parsed = JSON.parse(filtersParam);
            if (Array.isArray(parsed)) filters = parsed;
          } catch {}
        }

        setSearchQuery(queryParam ?? "");
        setActiveFilters(filters);
        setCommittedQuery(queryParam ?? "");
        setCommittedFilters(filters);
        setHasSearched(Boolean(queryParam || filtersParam));
      },
    ),
  );

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

  // Split around the placeholder rather than interpolated, so the query keeps
  // its emphasis wherever a translation puts it in the sentence.
  const noMatchText = createMemo(() =>
    t('No documents match "{query}"').split("{query}"),
  );

  const [isBatchArchiving, setIsBatchArchiving] = createSignal(false);
  const [batchError, setBatchError] = createSignal<string | null>(null);

  const isFileId = (id: string) => {
    const item = [...sortedResults(), ...allDocuments()].find((d) => d.id === id);
    return item?.type === "file" || Boolean(item?.fileUrl);
  };

  const batchArchive = async (ids: string[]) => {
    setBatchError(null);
    if (ids.length === 0) return;

    const fileIds = ids.filter((id) => isFileId(id));
    const documentIds = ids.filter((id) => !isFileId(id));

    // Whole sentences per case rather than clauses joined at runtime: the verb
    // does not sit where English puts it in every language.
    const documents = countLabel(
      documentIds.length,
      "{count} document",
      "{count} documents",
    );
    const files = countLabel(fileIds.length, "{count} file", "{count} files");
    const confirmation =
      documentIds.length === 0
        ? t("Permanently delete {files}?").replace("{files}", files)
        : fileIds.length === 0
          ? t("Archive {documents}?").replace("{documents}", documents)
          : t("Archive {documents} and permanently delete {files}?")
              .replace("{documents}", documents)
              .replace("{files}", files);

    if (!confirm(confirmation)) return;

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
        t("Failed to process {failed} of {items}.")
          .replace("{failed}", String(failed.length))
          .replace("{items}", countLabel(ids.length, "{count} item", "{count} items")),
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
        {isBatchArchiving() ? t("Processing…") : t("Archive / delete selected")}
      </button>
    </Show>
  );

  return (
    <div>
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
            placeholder={t("Find anything…")}
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
              title={t("Clear search")}
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
          {isSearching() ? t("Searching…") : t("Search")}
        </button>
      </div>

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
          {searchError()?.message ?? t("Search failed")}
        </div>
      </Show>

      <Show when={batchError()}>
        <div class="mb-6 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-800 text-size-medium">
          <Icon class="h-5 w-5 shrink-0" name="alert-circle" />
          {batchError()}
        </div>
      </Show>

      <Show when={!hasSearched()}>
        <Show when={allDocuments().length > 0}>
          <DocumentGroupedList
            items={allDocuments()}
            showToolbar={false}
            emptyText={t("No documents yet")}
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
              {isFetchingNextPage() ? t("Loading…") : t("Load more")}
            </button>
          </div>
        </Show>

        <Show when={allDocuments().length === 0 && isLoadingDocuments()}>
          <div class="py-12 text-center">
            <Icon
              class="mx-auto mb-4 h-10 w-10 animate-spin text-neutral-300"
              name="spinner"
            />
            <p class="text-neutral-500 text-size-medium">{t("Loading documents…")}</p>
          </div>
        </Show>

        <Show when={allDocuments().length === 0 && !isLoadingDocuments()}>
          <div class="py-12 text-center">
            <Icon class="mx-auto mb-4 h-12 w-12 text-neutral-300" name="document" />
            <h3 class="mb-2 font-semibold text-neutral-700 text-size-large">
              {t("No documents yet")}
            </h3>
            <p class="text-neutral-500 text-size-medium">
              {t("There are no documents in this space yet")}
            </p>
          </div>
        </Show>
      </Show>

      <Show when={hasSearched() && sortedResults().length > 0}>
        <DocumentGroupedList
          items={sortedResults() as unknown as DocumentWithProperties[]}
          showToolbar={false}
          batchActions={batchActions}
          splitAfter={showOtherSpaces() ? 5 : undefined}
          splitContent={otherSpacesSection}
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
            {t("No results found")}
          </h3>
          <p class="mb-8 text-neutral-600">
            <Show
              when={searchQuery().trim()}
              fallback={<span>{t("No documents match your filters")}</span>}
            >
              <span>
                {noMatchText()[0]}
                <span class="font-semibold">{searchQuery()}</span>
                {noMatchText()[1]}
              </span>
            </Show>
          </p>
        </div>
      </Show>

      {/* Nothing here, but something elsewhere — the one case where the other
          spaces are the whole answer rather than an aside. */}
      <Show when={hasSearched() && sortedResults().length === 0 && showOtherSpaces()}>
        {otherSpacesSection()}
      </Show>
    </div>
  );
}
