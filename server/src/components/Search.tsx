import { useLocation, useNavigate } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
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
import { useLocale, useTranslation } from "#composeables/useTranslation.ts";
import { canonicalPropertyKey, DOCUMENT_TYPE_FILTER_KEY } from "#documents/properties.ts";
import { mergeFilters, parseSearchQuery } from "#search/query.ts";
import { brandTextColor } from "#utils/color.ts";
import { t as translate } from "#utils/lang.ts";
import { DocumentGroupedList, type DocumentListItem } from "./DocumentGroupedList.tsx";
import { Icon } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";
import { PagerCursor } from "./PagerCursor.tsx";
import { SearchFilters } from "./SearchFilters.tsx";
import { type QueryProperty, SearchQueryInput } from "./SearchQueryInput.tsx";
import { SpaceLogo } from "./SpaceLogo.tsx";

interface Props {
  spaceId: string;
}

/** How much of this space's list sits above the other-spaces panel. */
const OTHER_SPACES_SPLIT = 5;

/** The catalogue carries no plural rules, so each form is its own key. */
function countLabel(lang: string, count: number, one: string, many: string): string {
  return translate(count === 1 ? one : many, lang).replace("{count}", String(count));
}

/**
 * Stand-in rows in the real list's frame, so results land where the placeholder
 * sat instead of after a blank stretch of page.
 */
function ListSkeleton(props: { rows: number }) {
  const t = useTranslation();

  const widths = ["w-3/5", "w-4/5", "w-2/5", "w-3/4", "w-1/2"];

  return (
    <div
      role="status"
      aria-label={t("Loading…")}
      class="animate-pulse overflow-hidden rounded-lg border border-neutral-100 bg-background"
    >
      <Index each={Array.from({ length: props.rows })}>
        {(_, index) => (
          <div
            class="flex items-center gap-3 py-2.5 pr-3 pl-[2.375rem]"
            classList={{ "border-neutral-100 border-t": index !== 0 }}
          >
            <div class="h-4 w-4 shrink-0 rounded bg-neutral-100" />
            <div class={`h-4 rounded bg-neutral-100 ${widths[index % widths.length]}`} />
          </div>
        )}
      </Index>
    </div>
  );
}

/** Two groups' worth: the shape of the answer, before it names the spaces. */
function OtherSpacesSkeleton() {
  return (
    <Index each={[0, 1]}>
      {() => (
        <div>
          <div class="mb-2 flex animate-pulse items-center gap-2">
            <div class="h-5 w-5 shrink-0 rounded-sm bg-neutral-200" />
            <div class="h-3.5 w-28 rounded bg-neutral-200" />
          </div>
          <ListSkeleton rows={2} />
        </div>
      )}
    </Index>
  );
}

export function Search(props: Props) {
  const t = useTranslation();
  const lang = useLocale();

  const { currentSpace, spaces } = useSpace();
  const navigate = useNavigate();
  const location = useLocation();
  const userCanEdit = createMemo(() => canEdit(currentSpace()?.userRole));

  const [searchQuery, setSearchQuery] = createSignal("");
  const [activeFilters, setActiveFilters] = createSignal<PropertyFilter[]>([]);
  const [hasSearched, setHasSearched] = createSignal(false);

  // The box holds both halves of a query: `key:value` terms filter, the rest is
  // full text. Everything downstream works on the split, never the raw string.
  const parsedQuery = createMemo(() => parseSearchQuery(searchQuery()));
  const queryFilters = createMemo(() =>
    mergeFilters(activeFilters(), parsedQuery().filters),
  );

  // The same key the filter row reads, so the two share one request.
  const { data: spaceProperties } = useQuery({
    queryKey: createMemo(() => ["properties", props.spaceId]),
    queryFn: () => api.properties.get(props.spaceId),
  });

  // What the box completes a filter term from. `_type` is offered under the name
  // the query syntax spells it with; the other internal keys are not offered.
  const completionProperties = createMemo<QueryProperty[]>(() =>
    (spaceProperties() ?? [])
      .filter((property) => canonicalPropertyKey(property.name) !== "title")
      .map((property) =>
        property.name === DOCUMENT_TYPE_FILTER_KEY
          ? { name: "type", values: property.values }
          : { name: property.name, values: property.values },
      )
      .filter((property) => !property.name.startsWith("_")),
  );

  const [committedQuery, setCommittedQuery] = createSignal("");
  const [committedFilters, setCommittedFilters] = createSignal<PropertyFilter[]>([]);

  const {
    items: results,
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
  const { data: otherSpaceResults, isLoading: isLoadingOtherSpaces } = useQuery({
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

  const otherSpacesPending = createMemo(
    () => isLoadingOtherSpaces() && committedQuery().trim().length > 0,
  );

  // Only alongside the first page: below that the user is deep in this space's
  // results, and a hint they have already scrolled past is noise. Held open
  // while pending too, so the panel is announced rather than dropped in once
  // the reader has settled on the results above it.
  const showOtherSpaces = createMemo(
    () => (otherSpaceGroups().length > 0 || otherSpacesPending()) && !hasPrevSearchPage(),
  );

  // The panel's slot is claimed but not yet filled, so the rows that belong below
  // it wait rather than filling the gap and being shoved down when it lands.
  const holdBackResults = createMemo(() => showOtherSpaces() && otherSpacesPending());

  const visibleResults = createMemo(() =>
    holdBackResults() ? sortedResults().slice(0, OTHER_SPACES_SPLIT) : sortedResults(),
  );

  // The tinted panel carries what no single row can: everything inside it comes
  // from somewhere other than the space being searched. It answers for its own
  // emptiness rather than trusting where it is rendered: a caption over nothing
  // claims results that do not exist.
  const otherSpacesSection = () => (
    <Show when={otherSpacesPending() || otherSpaceGroups().length > 0}>
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
        <div class="space-y-5" aria-busy={otherSpacesPending()}>
          <Show when={!otherSpacesPending()} fallback={<OtherSpacesSkeleton />}>
            <For each={otherSpaceGroups()}>
              {(group) => (
                <div>
                  <div class="mb-2 flex items-center gap-2">
                    {/* The space's own mark, as the switcher shows it: the logo
                        on its brand colour. The name repeats it in words, for a
                        space with no mark of its own and for anyone who cannot
                        tell them apart. */}
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
          </Show>
        </div>
      </div>
    </Show>
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

        // `q` is kept as it was typed, filter terms and all, so a shared link
        // reopens the box the reader left rather than a rewritten version of it.
        const parsed = parseSearchQuery(queryParam ?? "");
        setSearchQuery(queryParam ?? "");
        setActiveFilters(filters);
        setCommittedQuery(parsed.text);
        setCommittedFilters(mergeFilters(filters, parsed.filters));
        setHasSearched(Boolean(queryParam || filtersParam));
      },
    ),
  );

  const handleSearch = () => {
    const hasQuery = parsedQuery().text.length > 0;
    const hasFilters = queryFilters().length > 0;

    if (!hasQuery && !hasFilters) {
      setHasSearched(false);
      setCommittedQuery("");
      setCommittedFilters([]);
      updateUrlParams();
      return;
    }

    setCommittedQuery(parsedQuery().text);
    setCommittedFilters(queryFilters());
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
    () => parsedQuery().text.length > 0 || queryFilters().length > 0,
  );

  // `isFetching`, not the pager's `isLoading`: that one covers the first search
  // only, because the pager keeps the previous page on screen while the next
  // loads, so every later search has data and reports itself as merely fetching.
  const isSearchBusy = createMemo(() => hasSearched() && isFetchingSearch());

  // Nothing to keep on screen, so the rows are drawn empty rather than leaving
  // the page blank between the click and the answer.
  const showResultsSkeleton = createMemo(
    () => isSearchBusy() && sortedResults().length === 0,
  );

  // What is on screen belongs to the previous query. Dimmed rather than dropped:
  // the reader keeps their place, and the rows stop inviting a click they would
  // lose.
  const resultsAreStale = createMemo(() => isSearchBusy() && sortedResults().length > 0);

  // Split around the placeholder rather than interpolated, so the query keeps
  // its emphasis wherever a translation puts it in the sentence.
  const noMatchText = createMemo(() =>
    t('No documents match "{query}"').split("{query}"),
  );

  // Both counts, because the items are processed one request at a time: a plain
  // "Processing…" over a selection of fifty is indistinguishable from a hang.
  const [batchProgress, setBatchProgress] = createSignal<{
    done: number;
    total: number;
  } | null>(null);
  const isBatchArchiving = createMemo(() => batchProgress() !== null);
  const [batchError, setBatchError] = createSignal<string | null>(null);

  const batchProgressLabel = (progress: { done: number; total: number }) =>
    t("Processing {done} of {total}…")
      .replace("{done}", String(progress.done))
      .replace("{total}", String(progress.total));

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
      lang,
      documentIds.length,
      "{count} document",
      "{count} documents",
    );
    const files = countLabel(lang, fileIds.length, "{count} file", "{count} files");
    const confirmation =
      documentIds.length === 0
        ? t("Permanently delete {files}?").replace("{files}", files)
        : fileIds.length === 0
          ? t("Archive {documents}?").replace("{documents}", documents)
          : t("Archive {documents} and permanently delete {files}?")
              .replace("{documents}", documents)
              .replace("{files}", files);

    if (!confirm(confirmation)) return;

    setBatchProgress({ done: 0, total: ids.length });
    const advance = () =>
      setBatchProgress((progress) =>
        progress ? { ...progress, done: progress.done + 1 } : progress,
      );
    const failed: string[] = [];

    for (const id of documentIds) {
      try {
        await api.document.archive(props.spaceId, id);
      } catch (error) {
        console.error("Failed to archive document", id, error);
        failed.push(id);
      }
      advance();
    }

    for (const id of fileIds) {
      try {
        await api.upload.delete(props.spaceId, id);
      } catch (error) {
        console.error("Failed to delete file", id, error);
        failed.push(id);
      }
      advance();
    }

    setBatchProgress(null);

    if (failed.length > 0) {
      setBatchError(
        t("Failed to process {failed} of {items}.")
          .replace("{failed}", String(failed.length))
          .replace(
            "{items}",
            countLabel(lang, ids.length, "{count} item", "{count} items"),
          ),
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
        class="flex h-8 items-center gap-2 rounded-md border border-neutral-200 px-3 font-medium text-neutral-700 text-size-small transition-colors hover:border-neutral-300 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Show when={isBatchArchiving()}>
          <Icon class="h-3.5 w-3.5 animate-spin" name="spinner" />
        </Show>
        <Show when={batchProgress()} fallback={t("Archive / delete selected")}>
          {(progress) => (
            <span class="tabular-nums">{batchProgressLabel(progress())}</span>
          )}
        </Show>
      </button>
    </Show>
  );

  return (
    <div>
      {/* Negative margins cancel the view's gutter so the bar covers the results
          edge to edge as they scroll under it. Sticky already positions it, so the
          progress bar inside anchors here without a `relative` to fight it. */}
      <div class="sticky top-0 z-10 -mx-xs mb-6 border-neutral-50 border-b bg-background px-xs pt-xs pb-3 lg:-mx-m lg:px-m">
        {/* On the bar's own border: the one indicator that stays in view once the
            reader has scrolled past the results being replaced. */}
        <Show when={isSearchBusy()}>
          <div class="absolute bottom-0 left-0 h-0.5 w-full animate-pulse bg-primary-400" />
        </Show>

        <div class="mb-3 flex gap-3">
          <div class="relative flex-1 rounded-lg bg-background">
            <Icon
              class="pointer-events-none absolute top-1/2 left-4 z-10 h-5 w-5 -translate-y-1/2 text-neutral-400"
              name="search"
            />
            <SearchQueryInput
              value={searchQuery()}
              segments={parsedQuery().segments}
              properties={completionProperties()}
              placeholder={t("Find anything…")}
              onInput={setSearchQuery}
              onEnter={handleSearch}
            />
            {/* Neither control locks while a search runs: a query in flight is no
                reason to stop the reader typing the next one or clearing this
                one. */}
            <Show when={searchQuery()}>
              <IconButton
                class="absolute top-1/2 right-3 z-10 -translate-y-1/2"
                icon="cancel"
                label={t("Clear search")}
                onClick={clear}
              />
            </Show>
          </div>

          <button
            type="button"
            onClick={handleSearch}
            disabled={isSearchBusy() || !canSearch()}
            class="flex items-center gap-2 whitespace-nowrap rounded-lg bg-primary-500 px-5 py-3 font-medium text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Show
              when={!isSearchBusy()}
              fallback={<Icon class="h-4 w-4 animate-spin" name="spinner" />}
            >
              <Icon class="h-4 w-4" name="search" />
            </Show>
            {isSearchBusy() ? t("Searching…") : t("Search")}
          </button>
        </div>

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

      {/* The run drops the selection as it starts, which takes the toolbar and its
          button off screen, so the progress is reported here instead. */}
      <Show when={batchProgress()}>
        {(progress) => (
          <div
            role="status"
            aria-live="polite"
            class="mb-6 flex items-center gap-3 rounded-lg border border-neutral-100 bg-neutral-50 p-4 text-neutral-700 text-size-medium"
          >
            <Icon class="h-5 w-5 shrink-0 animate-spin" name="spinner" />
            <span class="tabular-nums">{batchProgressLabel(progress())}</span>
          </div>
        )}
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
          <ListSkeleton rows={8} />
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

      <Show when={showResultsSkeleton() && !searchError()}>
        <ListSkeleton rows={5} />
      </Show>

      <Show when={hasSearched() && sortedResults().length > 0}>
        <div
          aria-busy={resultsAreStale()}
          class="transition-opacity duration-150"
          classList={{ "pointer-events-none opacity-40": resultsAreStale() }}
        >
          <DocumentGroupedList
            items={visibleResults() as unknown as DocumentWithProperties[]}
            showToolbar={false}
            batchActions={batchActions}
            splitAfter={
              showOtherSpaces() && !holdBackResults() ? OTHER_SPACES_SPLIT : undefined
            }
            splitContent={otherSpacesSection}
          />

          {/* While the panel is pending there is nothing below it to split around,
              so it follows the rows that are shown — the same place it will take
              once the rest of them arrive with it. */}
          <Show when={holdBackResults()}>{otherSpacesSection()}</Show>

          {/* Paging an incomplete page would commit the reader to a set of results
              that is still being assembled. */}
          <PagerCursor
            class="mt-6 pt-5"
            hasPrevPage={hasPrevSearchPage()}
            hasNextPage={hasNextSearchPage()}
            disabled={isSearchBusy() || holdBackResults()}
            onPrev={prevSearchPage}
            onNext={nextSearchPage}
          />
        </div>
      </Show>

      {/* Off while a search is in flight: an empty page one and an empty result
          set look identical from here, and only one of them is an answer. */}
      <Show
        when={
          hasSearched() &&
          sortedResults().length === 0 &&
          !isSearchBusy() &&
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
              when={parsedQuery().text}
              fallback={<span>{t("No documents match your filters")}</span>}
            >
              <span>
                {noMatchText()[0]}
                <span class="font-semibold">{parsedQuery().text}</span>
                {noMatchText()[1]}
              </span>
            </Show>
          </p>
        </div>
      </Show>

      {/* Nothing here, but something elsewhere — the one case where the other
          spaces are the whole answer rather than an aside. */}
      <Show
        when={
          hasSearched() &&
          sortedResults().length === 0 &&
          !isSearchBusy() &&
          showOtherSpaces()
        }
      >
        {otherSpacesSection()}
      </Show>
    </div>
  );
}
