<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  chevronLeftLargeIcon,
  chevronRightThinIcon,
  closeCircleFilledIcon,
  closeXIcon,
  documentIcon,
  searchMagnifierIcon,
  spinnerIcon,
} from "~/src/assets/icons.ts";
import {
  api,
  type DocumentWithProperties,
  type PropertyFilter,
  type SearchResult,
} from "../api/client.ts";
import { useInfiniteQuery } from "../composeables/query.ts";
import { usePagedList } from "../composeables/usePagedList.ts";
import { formatDate, normalizeTimestamp } from "../utils/utils.ts";
import DocumentListItem from "./DocumentListItem.vue";
import SearchFilters from "./SearchFilters.vue";

const DATE_FILTER_KEY = "_date";

const props = defineProps<{
  spaceId: string;
  spaceSlug: string;
}>();

const searchQuery = ref("");
const activeFilters = ref<PropertyFilter[]>([]);
const hasSearched = ref(false);

// "Committed" values — only updated when the user explicitly submits a search.
// This prevents usePagedList from re-fetching while the user is still typing.
const committedQuery = ref("");
const committedFilters = ref<PropertyFilter[]>([]);

// Search results via usePagedList
const {
  items: results,
  total,
  isLoading: isSearching,
  isFetching: isFetchingSearch,
  error: searchError,
  page,
  totalPages,
  hasPrevPage,
  hasNextPage,
  prevPage: handlePrevPage,
  nextPage: handleNextPage,
} = usePagedList({
  queryKey: computed(() => [
    "search",
    props.spaceId,
    committedQuery.value,
    JSON.stringify(committedFilters.value),
  ]),
  fetcher: ({ limit, offset }) => {
    const queryParams: { q?: string; limit: number; offset: number; filters?: string } = {
      limit,
      offset,
    };
    if (committedQuery.value.trim()) queryParams.q = committedQuery.value;
    // Exclude client-side-only date filter from the API call
    const apiFilters = committedFilters.value.filter((f) => f.key !== DATE_FILTER_KEY);
    if (apiFilters.length > 0) {
      queryParams.filters = JSON.stringify(apiFilters);
    }
    return api.search.get(props.spaceId, queryParams).then((r) => ({
      items: r.results,
      total: r.total,
    }));
  },
  enabled: computed(() => hasSearched.value),
  pageSize: 20,
});

const sortedResults = computed(() => [...results.value].sort((a, b) => a.rank - b.rank));

// Apply committed date filter client-side on top of search results
const committedDateFilter = computed(() =>
  committedFilters.value.find((f) => f.key === DATE_FILTER_KEY)?.value ?? null,
);

const applyDateFilter = <T extends { updatedAt: string | Date }>(
  items: T[],
  dateFilter: string | null,
): T[] => {
  if (!dateFilter) return items;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return items.filter((item) => {
    const ua = normalizeTimestamp(item.updatedAt);
    switch (dateFilter) {
      case "today": return ua >= todayStart;
      case "week": return ua >= weekStart && ua < todayStart;
      case "month": return ua >= monthStart && ua < weekStart;
      case "older": return ua < monthStart;
      default: return true;
    }
  });
};

const dateFilteredResults = computed(() =>
  applyDateFilter(sortedResults.value, committedDateFilter.value),
);

const updateUrlParams = () => {
  const url = new URL(window.location.href);
  if (searchQuery.value.trim()) {
    url.searchParams.set("q", searchQuery.value);
  } else {
    url.searchParams.delete("q");
  }
  if (activeFilters.value.length > 0) {
    url.searchParams.set("filters", JSON.stringify(activeFilters.value));
  } else {
    url.searchParams.delete("filters");
  }
  window.history.replaceState({}, "", url);
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
  queryKey: ["documents", props.spaceId],
  queryFn: async ({ pageParam = 0 }) => {
    return await api.documents.get(props.spaceId, {
      limit: documentsPageSize,
      offset: pageParam,
    });
  },
  getNextPageParam: (lastPage, allPages) => {
    const loadedCount = allPages.reduce((sum, page) => sum + page.documents.length, 0);
    return loadedCount < lastPage.total ? loadedCount : undefined;
  },
  initialPageParam: 0,
});

// Flatten all documents from pages (only when not searching)
const allDocuments = computed(() => {
  if (hasSearched.value) return [];
  if (!documentsData.value) return [];
  return documentsData.value.pages.flatMap((page) => page.documents);
});

// Active date filter from activeFilters (for client-side browse filtering)
const activeDateFilter = computed(() =>
  activeFilters.value.find((f) => f.key === DATE_FILTER_KEY)?.value ?? null,
);

// Date-filtered documents for the browse (non-search) view
const filteredAllDocuments = computed(() =>
  applyDateFilter(allDocuments.value, activeDateFilter.value),
);

// Group documents by update time
const groupedDocuments = computed(() => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const groups = {
    today: [] as DocumentWithProperties[],
    thisWeek: [] as DocumentWithProperties[],
    thisMonth: [] as DocumentWithProperties[],
    older: [] as DocumentWithProperties[],
  };

  for (const doc of filteredAllDocuments.value) {
    const updatedAt = normalizeTimestamp(doc.updatedAt);
    if (updatedAt >= todayStart) {
      groups.today.push(doc);
    } else if (updatedAt >= weekStart) {
      groups.thisWeek.push(doc);
    } else if (updatedAt >= monthStart) {
      groups.thisMonth.push(doc);
    } else {
      groups.older.push(doc);
    }
  }

  for (const key of Object.keys(groups)) {
    groups[key as keyof typeof groups].sort(
      (a, b) =>
        normalizeTimestamp(b.updatedAt).getTime() -
        normalizeTimestamp(a.updatedAt).getTime(),
    );
  }

  return groups;
});

// Watch for scroll to load more
const handleScroll = () => {
  if (hasSearched.value) return;
  if (isFetchingNextPage.value || !hasMoreDocuments.value) return;

  const scrollPosition = window.innerHeight + window.scrollY;
  const threshold = document.documentElement.scrollHeight - 500;

  if (scrollPosition >= threshold) {
    fetchNextPage();
  }
};

onMounted(() => {
  if (!import.meta.env.SSR) {
    window.addEventListener("scroll", handleScroll);
  }

  const urlParams = new URLSearchParams(window.location.search);
  const queryParam = urlParams.get("q");
  const filtersParam = urlParams.get("filters");

  if (queryParam) {
    searchQuery.value = queryParam;
  }

  if (filtersParam) {
    try {
      const parsed = JSON.parse(filtersParam);
      if (Array.isArray(parsed)) {
        activeFilters.value = parsed;
      }
    } catch {
      // Ignore invalid filters
    }
  }

  if (queryParam || filtersParam) {
    committedQuery.value = queryParam ?? "";
    committedFilters.value = [...activeFilters.value];
    // Only enter search mode if there's a query or non-date filters
    const hasNonDateFilters = activeFilters.value.some((f) => f.key !== DATE_FILTER_KEY);
    if (queryParam || hasNonDateFilters) {
      hasSearched.value = true;
    }
  }
});

onUnmounted(() => {
  window.removeEventListener("scroll", handleScroll);
});

const handleSearch = () => {
  const hasQuery = searchQuery.value.trim().length > 0;
  const hasNonDateFilters = activeFilters.value.some((f) => f.key !== DATE_FILTER_KEY);

  if (!hasQuery && !hasNonDateFilters) {
    // Only date filter or nothing — stay in browse mode, apply filter client-side
    hasSearched.value = false;
    committedQuery.value = "";
    committedFilters.value = [];
    updateUrlParams();
    return;
  }

  committedQuery.value = searchQuery.value;
  committedFilters.value = [...activeFilters.value];
  hasSearched.value = true;
  updateUrlParams();
};

const clear = () => {
  searchQuery.value = "";
  hasSearched.value = false;
  committedQuery.value = "";
  committedFilters.value = [];
  updateUrlParams();
};

const clearAll = () => {
  clear();
  activeFilters.value = [];
  updateUrlParams();
};

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === "Enter") {
    handleSearch();
  }
};

const canSearch = computed(() => {
  return (
    searchQuery.value.trim().length > 0 ||
    activeFilters.value.some((f) => f.key !== DATE_FILTER_KEY)
  );
});
</script>

<template>
  <div>
    <!-- Search Box -->
    <div class="flex gap-3 mb-6">
      <div class="relative flex-1">
        <div class="svg-icon absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-neutral-400 pointer-events-none" v-html="searchMagnifierIcon" />
        <input
          v-model="searchQuery"
          type="text"
          autofocus
          placeholder="Find documents… (e.g. 'typescript', 'database design', 'react ui')"
          class="w-full py-3 pl-12 pr-12 border border-neutral-100 rounded-lg text-base bg-background focus:outline-none focus:border-primary-300 focus:ring-2 focus:ring-primary-100 disabled:bg-neutral-100 disabled:cursor-not-allowed"
          @keydown="handleKeydown"
          :disabled="isSearching"
        />
        <button
          v-if="searchQuery"
          @click="clear"
          class="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-neutral hover:text-neutral-800 hover:bg-neutral-100 rounded-sm disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="isSearching"
          title="Clear search"
        >
          <div class="svg-icon w-4 h-4" v-html="closeXIcon" />
        </button>
      </div>

      <button
        @click="handleSearch"
        :disabled="isSearching || !canSearch"
        class="flex items-center gap-2 px-5 py-3 bg-primary-500 text-white font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
      >
        <div v-if="!isSearching" class="svg-icon w-4 h-4" v-html="searchMagnifierIcon" />
        <div v-else class="svg-icon w-4 h-4 animate-spin" v-html="spinnerIcon" />
        {{ isSearching ? "Searching…" : "Search" }}
      </button>
    </div>

    <!-- Two-column layout -->
    <div class="flex gap-6 items-start">

      <!-- Filter Sidebar -->
      <div class="hidden lg:block w-56 shrink-0 sticky top-6">
        <div class="bg-background border border-neutral-100 rounded-lg overflow-hidden">
          <SearchFilters
            :spaceId="props.spaceId"
            v-model="activeFilters"
            @search="handleSearch"
          />
        </div>
      </div>

      <!-- Main Content -->
      <div class="flex-1 min-w-0">

        <!-- Mobile filters (collapsed inline above results) -->
        <div class="lg:hidden mb-4">
          <div class="bg-background border border-neutral-100 rounded-lg overflow-hidden">
            <SearchFilters
              :spaceId="props.spaceId"
              v-model="activeFilters"
              @search="handleSearch"
            />
          </div>
        </div>

        <!-- Error Message -->
        <div v-if="searchError" class="flex items-center gap-3 p-4 mb-6 bg-red-50 text-red-800 border border-red-200 rounded-lg text-size-medium">
          <div class="svg-icon w-5 h-5 shrink-0" v-html="closeCircleFilledIcon" />
          {{ searchError.message ?? "Search failed" }}
        </div>

        <!-- Search Results -->
        <div v-if="dateFilteredResults.length > 0">
          <div class="mb-5 pb-4 border-b border-neutral-100">
            <p class="text-size-medium text-neutral-700">
              <span class="font-semibold">{{ dateFilteredResults.length }}</span>
              <span v-if="committedDateFilter"> matching</span>
              result{{ dateFilteredResults.length !== 1 ? "s" : "" }}
              <span v-if="activeFilters.filter(f => f.key !== DATE_FILTER_KEY).length > 0" class="text-neutral-500">
                with {{ activeFilters.filter(f => f.key !== DATE_FILTER_KEY).length }} filter{{ activeFilters.filter(f => f.key !== DATE_FILTER_KEY).length !== 1 ? "s" : "" }}
              </span>
            </p>
          </div>

          <div class="flex flex-col gap-4">
            <DocumentListItem
              v-for="result in dateFilteredResults"
              :key="result.id"
              :document="result"
              :space-slug="props.spaceSlug"
              :show-rank="true"
              :show-snippet="true"
              :search-query="searchQuery"
            />
          </div>

          <!-- Pagination -->
          <div v-if="totalPages > 1" class="flex justify-between items-center mt-10 pt-6 border-t border-neutral-100">
            <button
              @click="handlePrevPage"
              :disabled="!hasPrevPage || isFetchingSearch"
              class="flex items-center gap-2 px-4 py-2.5 bg-background border border-neutral-100 rounded-lg font-medium text-size-medium hover:bg-neutral-50 hover:border-primary-300 hover:text-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <div class="svg-icon w-5 h-5" v-html="chevronLeftLargeIcon" />
              Previous
            </button>
            <span class="text-size-medium text-neutral-500">
              Page <span class="font-semibold">{{ page }}</span> of
              <span class="font-semibold">{{ totalPages }}</span>
            </span>
            <button
              @click="handleNextPage"
              :disabled="!hasNextPage || isFetchingSearch"
              class="flex items-center gap-2 px-4 py-2.5 bg-background border border-neutral-100 rounded-lg font-medium text-size-medium hover:bg-neutral-50 hover:border-primary-300 hover:text-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Next
              <div class="svg-icon w-5 h-5" v-html="chevronRightThinIcon" />
            </button>
          </div>
        </div>

        <!-- No Search Results -->
        <div v-else-if="hasSearched && !isSearching && !searchError" class="text-center py-12">
          <div class="svg-icon w-12 h-12 mx-auto mb-4 text-neutral-300" v-html="searchMagnifierIcon" />
          <h3 class="text-size-large font-semibold text-neutral-800 mb-2">No results found</h3>
          <p class="text-neutral-600 mb-8">
            <span v-if="searchQuery.trim()">
              No documents match <span class="font-semibold">"{{ searchQuery }}"</span>
            </span>
            <span v-else>No documents match your filters</span>
          </p>
          <div class="max-w-sm mx-auto p-5 bg-neutral-50 border border-neutral-100 rounded-lg text-left">
            <p class="font-semibold text-neutral-700 mb-3 text-size-small">Search tips</p>
            <ul class="list-disc pl-5 space-y-1.5 text-size-small text-neutral-600">
              <li>Use natural language: <code class="px-1 py-0.5 bg-neutral-200 rounded-sm text-[11px] font-mono">database design basics</code></li>
              <li>Exact phrases: <code class="px-1 py-0.5 bg-neutral-200 rounded-sm text-[11px] font-mono">"programming language"</code></li>
              <li>Try removing some filters</li>
              <li>Check you have access to the documents</li>
            </ul>
          </div>
        </div>

        <!-- All Documents (browse mode) -->
        <div v-else-if="!hasSearched && !isLoadingDocuments && filteredAllDocuments.length > 0">
          <div class="mb-5 pb-4 border-b border-neutral-100">
            <p class="text-size-medium text-neutral-700">
              <span class="font-semibold">{{ filteredAllDocuments.length }}</span>
              document{{ filteredAllDocuments.length !== 1 ? "s" : "" }}
              <span v-if="documentsData && documentsData.pages[0] && !activeDateFilter" class="text-neutral-500">
                · {{ documentsData.pages[0].total }} total
              </span>
            </p>
          </div>

          <template v-for="(docs, groupKey) in groupedDocuments" :key="groupKey">
            <div v-if="docs.length > 0" class="mb-10">
              <h3 class="text-size-small font-medium text-neutral-500 mb-3 pb-2 border-b border-neutral-100 capitalize">
                {{ groupKey === "thisWeek" ? "This Week" : groupKey === "thisMonth" ? "This Month" : groupKey }}
              </h3>
              <div class="flex flex-col gap-1">
                <DocumentListItem
                  v-for="doc in docs"
                  :key="doc.id"
                  :document="doc"
                  :space-slug="props.spaceSlug"
                />
              </div>
            </div>
          </template>

          <div v-if="hasMoreDocuments" class="flex justify-center mt-6 pt-6 border-t border-neutral-100">
            <button
              @click="() => fetchNextPage()"
              :disabled="isFetchingNextPage"
              class="flex items-center gap-2 px-5 py-2.5 bg-background border border-neutral-100 rounded-lg font-medium text-size-medium hover:border-primary-300 hover:text-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <div v-if="!isFetchingNextPage" class="svg-icon w-4 h-4" v-html="searchMagnifierIcon" />
              <div v-else class="svg-icon w-4 h-4 animate-spin" v-html="spinnerIcon" />
              {{ isFetchingNextPage ? "Loading…" : "Load more" }}
            </button>
          </div>
        </div>

        <!-- No documents (after date filter, empty state) -->
        <div v-else-if="!hasSearched && !isLoadingDocuments && filteredAllDocuments.length === 0 && activeDateFilter" class="text-center py-12">
          <div class="svg-icon w-12 h-12 mx-auto mb-4 text-neutral-300" v-html="documentIcon" />
          <h3 class="text-size-large font-semibold text-neutral-700 mb-2">No documents in this period</h3>
          <p class="text-neutral-500 text-size-medium">Try a different time range in the filters</p>
        </div>

        <!-- Loading Documents -->
        <div v-else-if="!hasSearched && isLoadingDocuments" class="text-center py-12">
          <div class="svg-icon w-10 h-10 mx-auto mb-4 text-neutral-300 animate-spin" v-html="spinnerIcon" />
          <p class="text-size-medium text-neutral-500">Loading documents…</p>
        </div>

        <!-- No Documents at all -->
        <div v-else-if="!hasSearched && !isLoadingDocuments && allDocuments.length === 0" class="text-center py-12">
          <div class="svg-icon w-12 h-12 mx-auto mb-4 text-neutral-300" v-html="documentIcon" />
          <h3 class="text-size-large font-semibold text-neutral-700 mb-2">No documents yet</h3>
          <p class="text-neutral-500 text-size-medium">There are no documents in this space yet</p>
        </div>

      </div>
    </div>
  </div>
</template>
