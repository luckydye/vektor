<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useInfiniteQuery } from "@tanstack/vue-query";
import { formatDate } from "../utils/utils.ts";
import {
  api,
  type DocumentWithProperties,
  type PropertyFilter,
  type SearchResult,
} from "../api/client.ts";
import SearchFilters from "./SearchFilters.vue";
import DocumentListItem from "./DocumentListItem.vue";

const props = defineProps<{
  spaceId: string;
  spaceSlug: string;
}>();

const searchQuery = ref("");
const results = ref<SearchResult[]>([]);
const isLoading = ref(false);
const error = ref<string | null>(null);
const total = ref(0);
const offset = ref(0);
const limit = 20;
const hasSearched = ref(false);

// Advanced filter state
const activeFilters = ref<PropertyFilter[]>([]);

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
  hasNextPage,
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
    const updatedAt = new Date(doc.updatedAt);
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
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  return groups;
});

// Watch for scroll to load more
const handleScroll = () => {
  if (hasSearched.value) return;
  if (isFetchingNextPage.value || !hasNextPage.value) return;

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
    handleSearch();
  }
});

const search = async () => {
  const hasQuery = searchQuery.value.trim().length > 0;
  const hasFilters = activeFilters.value.length > 0;

  if (!hasQuery && !hasFilters) {
    results.value = [];
    total.value = 0;
    hasSearched.value = false;
    updateUrlParams();
    return;
  }

  isLoading.value = true;
  error.value = null;
  hasSearched.value = true;
  updateUrlParams();

  try {
    const queryParams: { q?: string; limit: number; offset: number; filters?: string } = {
      limit,
      offset: offset.value,
    };

    if (hasQuery) {
      queryParams.q = searchQuery.value;
    }

    if (hasFilters) {
      queryParams.filters = JSON.stringify(activeFilters.value);
    }

    const data = await api.search.get(props.spaceId, queryParams);
    results.value = data.results;
    total.value = data.total;
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Search failed";
    results.value = [];
    total.value = 0;
  } finally {
    isLoading.value = false;
  }
};

const handleSearch = async () => {
  offset.value = 0;
  await search();
};

const handleNextPage = () => {
  offset.value += limit;
  search();
};

const handlePrevPage = () => {
  offset.value = Math.max(0, offset.value - limit);
  search();
};

const clear = () => {
  searchQuery.value = "";
  results.value = [];
  total.value = 0;
  error.value = null;
  offset.value = 0;
  hasSearched.value = false;
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
    <div class="mb-8">
      <h1 class="text-3xl font-bold text-neutral-900">Find Documents</h1>
      <p class="mt-2 text-sm text-neutral-600">
        Search across all documents you have access to in this space with semantic ranking
      </p>
    </div>

    <!-- Search Box -->
    <div class="flex gap-3 mb-4">
      <div class="relative flex-1">
        <svg class="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-neutral-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
        </svg>
        <input
          v-model="searchQuery"
          type="text"
          autofocus
          placeholder="Find documents... (e.g., 'typescript', 'database design', 'react ui')"
          class="w-full py-3 pl-12 pr-12 border-2 border-neutral-100 rounded-lg text-base bg-neutral-50 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-neutral-200 disabled:cursor-not-allowed"
          @keydown="handleKeydown"
          :disabled="isLoading"
        />
        <button
          v-if="searchQuery || activeFilters.length > 0"
          @click="clearAll"
          class="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-neutral-500 hover:text-neutral-800 hover:bg-neutral-200 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="isLoading"
          title="Clear all"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </button>
      </div>

      <button
        @click="handleSearch"
        :disabled="isLoading || !canSearch"
        class="flex items-center gap-2 px-6 py-3 bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-600 hover:-translate-y-0.5 hover:shadow-md disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none transition-all whitespace-nowrap"
      >
        <svg v-if="!isLoading" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
        </svg>
        <svg v-else class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        {{ isLoading ? "Searching..." : "Search" }}
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
    <div v-if="error" class="flex items-center gap-3 p-4 mb-6 bg-red-50 text-red-800 border border-red-200 rounded-lg text-sm">
      <svg class="w-5 h-5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"></path>
      </svg>
      {{ error }}
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
          v-for="result in results.sort((a, b) => a.rank - b.rank)"
          :key="result.id"
          :document="result"
          :space-slug="props.spaceSlug"
          :show-rank="true"
          :show-snippet="true"
          :search-query="searchQuery"
        />
      </div>

      <!-- Pagination -->
      <div v-if="total > limit" class="flex justify-between items-center mt-10 pt-6 border-t border-neutral-100">
        <button
          @click="handlePrevPage"
          :disabled="offset === 0 || isLoading"
          class="flex items-center gap-2 px-4 py-2.5 bg-background border border-neutral-100 rounded-lg font-medium text-sm hover:bg-neutral-50 hover:border-blue-500 hover:text-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path>
          </svg>
          Previous
        </button>
        <span class="text-sm text-neutral-500">
          Page <span class="font-semibold">{{ Math.floor(offset / limit) + 1 }}</span> of
          <span class="font-semibold">{{ Math.ceil(total / limit) }}</span>
        </span>
        <button
          @click="handleNextPage"
          :disabled="offset + limit >= total || isLoading"
          class="flex items-center gap-2 px-4 py-2.5 bg-background border border-neutral-100 rounded-lg font-medium text-sm hover:bg-neutral-50 hover:border-blue-500 hover:text-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Next
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>
          </svg>
        </button>
      </div>
    </div>

    <!-- No Results -->
    <div v-else-if="hasSearched && !isLoading && !error">
      <svg class="w-16 h-16 mx-auto mb-6 text-neutral-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
      </svg>
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
          <li>Use natural language for broader matches: <code class="px-1.5 py-0.5 bg-neutral-200 rounded text-xs font-mono text-neutral-800">database design basics</code></li>
          <li>Exact phrases still help when you know the wording: <code class="px-1.5 py-0.5 bg-neutral-200 rounded text-xs font-mono text-neutral-800">"programming language"</code></li>
          <li>Short prefixes can still work for common terms: <code class="px-1.5 py-0.5 bg-neutral-200 rounded text-xs font-mono text-neutral-800">java</code></li>
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

      <div v-if="hasNextPage" class="flex justify-center mt-8 pt-8">
        <button
          @click="() => fetchNextPage()"
          :disabled="isFetchingNextPage"
          class="flex items-center gap-2 px-6 py-3 bg-background border-2 border-neutral-100 rounded-lg font-medium text-sm hover:border-blue-500 hover:text-blue-600 hover:-translate-y-0.5 hover:shadow-md disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none transition-all"
        >
          <svg v-if="!isFetchingNextPage" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
          </svg>
          <svg v-else class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          {{ isFetchingNextPage ? "Loading more..." : "Load more documents" }}
        </button>
      </div>
    </div>

    <!-- Loading Documents -->
    <div v-else-if="!hasSearched && isLoadingDocuments">
      <svg class="w-16 h-16 mx-auto mb-6 text-neutral-300 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
      <h3 class="text-center text-xl font-semibold text-neutral-700">Loading documents...</h3>
    </div>

    <!-- No Documents -->
    <div v-else-if="!hasSearched && !isLoadingDocuments && allDocuments.length === 0">
      <svg class="w-16 h-16 mx-auto mb-6 text-neutral-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
      </svg>
      <h3 class="text-center text-xl font-semibold text-neutral-700 mb-2">No documents yet</h3>
      <p class="text-center text-neutral-500">There are no documents in this space yet</p>
    </div>
  </div>
</template>
