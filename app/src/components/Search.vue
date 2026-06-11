<script setup lang="ts">
import { useInfiniteQuery } from "@tanstack/vue-query";
import { computed, onMounted, ref } from "vue";
import {
  chevronDownThinIcon,
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
import { usePagedList } from "../composeables/usePagedList.ts";
import { formatDate, normalizeTimestamp } from "../utils/utils.ts";
import DocumentListItem from "./DocumentListItem.vue";
import SearchFilters from "./SearchFilters.vue";

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
    if (committedFilters.value.length > 0) {
      queryParams.filters = JSON.stringify(committedFilters.value);
    }
    return api.search.get(props.spaceId, queryParams).then((r) => ({
      items: r.results,
      total: r.total,
    }));
  },
  enabled: computed(() => hasSearched.value),
  pageSize: 20,
});

const sortedResults = computed(() =>
  [...results.value].sort((a, b) => a.rank - b.rank),
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

  for (const doc of allDocuments.value) {
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
    // Commit directly so usePagedList fires without a redundant handleSearch() call
    committedQuery.value = queryParam ?? "";
    committedFilters.value = [...activeFilters.value];
    hasSearched.value = true;
  }
});

const handleSearch = () => {
  const hasQuery = searchQuery.value.trim().length > 0;
  const hasFilters = activeFilters.value.length > 0;

  if (!hasQuery && !hasFilters) {
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
  return searchQuery.value.trim().length > 0 || activeFilters.value.length > 0;
});
</script>

<template>
  <div>
    <!-- Search Box -->
    <div class="flex gap-3 mb-4">
      <div class="relative flex-1">
        <div class="svg-icon absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-neutral-400 pointer-events-none" v-html="searchMagnifierIcon" />
        <input
          v-model="searchQuery"
          type="text"
          autofocus
          placeholder="Find documents... (e.g., 'typescript', 'database design', 'react ui')"
          class="w-full py-3 pl-12 pr-12 border-2 border-neutral-100 rounded-lg text-base bg-neutral-50 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-neutral-200 disabled:cursor-not-allowed"
          @keydown="handleKeydown"
          :disabled="isSearching"
        />
          <button
            v-if="searchQuery || activeFilters.length > 0"
            @click="clearAll"
            class="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-neutral-500 hover:text-neutral-800 hover:bg-neutral-200 rounded-sm disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="isSearching"
          title="Clear all"
        >
          <div class="svg-icon w-5 h-5" v-html="closeXIcon" />
        </button>
      </div>

      <button
        @click="handleSearch"
        :disabled="isSearching || !canSearch"
        class="flex items-center gap-2 px-6 py-3 bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-600 hover:-translate-y-0.5 hover:shadow-md disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none transition-all whitespace-nowrap"
      >
        <div v-if="!isSearching" class="svg-icon w-5 h-5" v-html="searchMagnifierIcon" />
        <div v-else class="svg-icon w-5 h-5 animate-spin" v-html="spinnerIcon" />
        {{ isSearching ? "Searching..." : "Search" }}
      </button>
    </div>

    <!-- Filter Panel -->
    <div class="mb-6">
      <SearchFilters
        :spaceId="props.spaceId"
        v-model="activeFilters"
        @search="handleSearch"
      />
    </div>

    <!-- Error Message -->
    <div v-if="searchError" class="flex items-center gap-3 p-4 mb-6 bg-red-50 text-red-800 border border-red-200 rounded-lg text-sm">
      <div class="svg-icon w-5 h-5 shrink-0" v-html="closeCircleFilledIcon" />
      {{ searchError.message ?? 'Search failed' }}
    </div>

    <!-- Search Results -->
    <div v-if="results.length > 0" class="mt-8">
    <div class="mb-6 pb-4 border-b-1 border-neutral-100">
      <p class="text-sm text-neutral-700">
        <span class="font-semibold">{{ total }}</span>
        result{{ total !== 1 ? "s" : "" }}
        <span v-if="activeFilters.length > 0" class="text-neutral-500">
          with {{ activeFilters.length }} filter{{ activeFilters.length !== 1 ? "s" : "" }}
        </span>
      </p>
    </div>

    <div class="flex flex-col gap-4">
      <DocumentListItem
        v-for="result in sortedResults"
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
        class="flex items-center gap-2 px-4 py-2.5 bg-background border border-neutral-100 rounded-lg font-medium text-sm hover:bg-neutral-50 hover:border-blue-500 hover:text-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        <div class="svg-icon w-5 h-5" v-html="chevronLeftLargeIcon" />
        Previous
      </button>
      <span class="text-sm text-neutral-500">
        Page <span class="font-semibold">{{ page }}</span> of
        <span class="font-semibold">{{ totalPages }}</span>
      </span>
      <button
        @click="handleNextPage"
        :disabled="!hasNextPage || isFetchingSearch"
        class="flex items-center gap-2 px-4 py-2.5 bg-background border border-neutral-100 rounded-lg font-medium text-sm hover:bg-neutral-50 hover:border-blue-500 hover:text-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Next
        <div class="svg-icon w-5 h-5" v-html="chevronRightThinIcon" />
      </button>
    </div>
  </div>

    <!-- No Results -->
    <div v-else-if="hasSearched && !isSearching && !searchError">
      <div class="svg-icon w-16 h-16 mx-auto mb-6 text-neutral-300" v-html="searchMagnifierIcon" />
      <h3 class="text-2xl font-semibold text-neutral-800 mb-2">No results found</h3>
      <p class="text-neutral-600 mb-8">
        <span v-if="searchQuery.trim()">
          No documents match your search for
          <span class="font-semibold">"{{ searchQuery }}"</span>
        </span>
        <span v-else>
          No documents match your filters
        </span>
      </p>

      <div class="max-w-md mx-auto p-6 bg-neutral-50 border border-neutral-100 rounded-lg text-left">
        <p class="font-semibold text-neutral-700 mb-3">💡 Search tips:</p>
        <ul class="list-disc pl-6 space-y-2 text-sm text-neutral-600">
          <li>Use natural language for broader matches: <code class="px-1.5 py-0.5 bg-neutral-200 rounded-sm text-xs font-mono text-neutral-800">database design basics</code></li>
          <li>Exact phrases still help when you know the wording: <code class="px-1.5 py-0.5 bg-neutral-200 rounded-sm text-xs font-mono text-neutral-800">"programming language"</code></li>
          <li>Short prefixes can still work for common terms: <code class="px-1.5 py-0.5 bg-neutral-200 rounded-sm text-xs font-mono text-neutral-800">java</code></li>
          <li>Use property filters to narrow down by metadata</li>
          <li>Make sure you have access to the documents you're searching for</li>
        </ul>
      </div>
    </div>

    <!-- All Documents (when not searching) -->
    <div v-else-if="!hasSearched && !isLoadingDocuments && allDocuments.length > 0" class="mt-8">
      <div class="mb-6 pb-4 border-b-1 border-neutral-100">
        <p class="text-sm text-neutral-700">
          <span class="font-semibold">{{ allDocuments.length }}</span>
          document{{ allDocuments.length !== 1 ? "s" : "" }}
          <span v-if="documentsData && documentsData.pages[0]" class="text-neutral-500">
            · {{ documentsData.pages[0].total }} total
          </span>
        </p>
      </div>

      <template v-for="(docs, groupKey) in groupedDocuments" :key="groupKey">
        <div v-if="docs.length > 0" class="mb-12">
          <h3 class="text-base mb-4 pb-2 border-b-1 border-neutral-100 capitalize">
            {{ groupKey === 'thisWeek' ? 'This Week' : groupKey === 'thisMonth' ? 'This Month' : groupKey }}
          </h3>
          <div class="flex flex-col gap-2">
            <DocumentListItem
              v-for="doc in docs"
              :key="doc.id"
              :document="doc"
              :space-slug="props.spaceSlug"
            />
          </div>
        </div>
      </template>

      <div v-if="hasMoreDocuments" class="flex justify-center mt-8 pt-8">
        <button
          @click="() => fetchNextPage()"
          :disabled="isFetchingNextPage"
          class="flex items-center gap-2 px-6 py-3 bg-background border-2 border-neutral-100 rounded-lg font-medium text-sm hover:border-blue-500 hover:text-blue-600 hover:-translate-y-0.5 hover:shadow-md disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none transition-all"
        >
          <div v-if="!isFetchingNextPage" class="svg-icon w-5 h-5" v-html="chevronDownThinIcon" />
          <div v-else class="svg-icon w-5 h-5 animate-spin" v-html="spinnerIcon" />
          {{ isFetchingNextPage ? "Loading more..." : "Load more documents" }}
        </button>
      </div>
    </div>

    <!-- Loading Documents -->
    <div v-else-if="!hasSearched && isLoadingDocuments" class="text-center">
      <div class="svg-icon w-16 h-16 mx-auto mb-6 text-neutral-300 animate-spin" v-html="spinnerIcon" />
      <h3 class="text-center text-xl font-semibold text-neutral-700">Loading documents...</h3>
    </div>

    <!-- No Documents -->
    <div v-else-if="!hasSearched && !isLoadingDocuments && allDocuments.length === 0">
      <div class="svg-icon w-16 h-16 mx-auto mb-6 text-neutral-300" v-html="documentIcon" />
      <h3 class="text-center text-xl font-semibold text-neutral-700 mb-2">No documents yet</h3>
      <p class="text-center text-neutral-500">There are no documents in this space yet</p>
    </div>
  </div>
</template>
