<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watchEffect } from "vue";
import {
  archiveIcon,
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
import { canEdit } from "../composeables/usePermissions.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { usePagedList } from "../composeables/usePagedList.ts";
import { formatDate, normalizeTimestamp } from "../utils/utils.ts";
import DocumentListItem from "./DocumentListItem.vue";
import SearchFilters from "./SearchFilters.vue";

const props = defineProps<{
  spaceId: string;
  spaceSlug: string;
}>();

const { currentSpace } = useSpace();
const userCanEdit = computed(() => canEdit(currentSpace.value?.userRole));

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

const sortedResults = computed(() => [...results.value].sort((a, b) => a.rank - b.rank));

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

// Items to group: search results when filter-only, otherwise browse docs
const itemsToGroup = computed<Array<SearchResult | DocumentWithProperties>>(() => {
  if (hasSearched.value && !committedQuery.value.trim()) return sortedResults.value;
  return allDocuments.value;
});

// Group documents by update time
const groupedDocuments = computed(() => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const groups = {
    today: [] as (SearchResult | DocumentWithProperties)[],
    thisWeek: [] as (SearchResult | DocumentWithProperties)[],
    thisMonth: [] as (SearchResult | DocumentWithProperties)[],
    older: [] as (SearchResult | DocumentWithProperties)[],
  };

  for (const doc of itemsToGroup.value) {
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
    hasSearched.value = true;
  }
});

onUnmounted(() => {
  window.removeEventListener("scroll", handleScroll);
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

// Selection state
const selectedIds = ref<Set<string>>(new Set());
const headerCheckboxRef = ref<HTMLInputElement | null>(null);

const currentItems = computed<Array<{ id: string }>>(
  () => (hasSearched.value ? sortedResults.value : allDocuments.value),
);

const allSelected = computed(
  () => currentItems.value.length > 0 && currentItems.value.every((item) => selectedIds.value.has(item.id)),
);
const someSelected = computed(
  () => selectedIds.value.size > 0 && !allSelected.value,
);

watchEffect(() => {
  if (headerCheckboxRef.value) {
    headerCheckboxRef.value.indeterminate = someSelected.value;
  }
});

const toggleSelect = (id: string) => {
  const next = new Set(selectedIds.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  selectedIds.value = next;
};

const toggleSelectAll = () => {
  if (allSelected.value) {
    selectedIds.value = new Set();
  } else {
    selectedIds.value = new Set(currentItems.value.map((item) => item.id));
  }
};

const deselectAll = () => {
  selectedIds.value = new Set();
};

// Batch operations
const isBatchArchiving = ref(false);

const batchArchive = async () => {
  const count = selectedIds.value.size;
  if (!confirm(`Archive ${count} document${count !== 1 ? "s" : ""}?`)) return;

  isBatchArchiving.value = true;
  try {
    for (const id of selectedIds.value) {
      await api.documents.archive(props.spaceId, id);
    }
    window.location.reload();
  } catch {
    isBatchArchiving.value = false;
  }
};
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

        <!-- Document table (shared by both search results and browse mode) -->
        <div v-if="currentItems.length > 0">

          <!-- Shared table header / batch toolbar -->
          <div
            class="grid grid-cols-[32px_1fr_200px_140px] border-b border-neutral-100 sticky top-0 z-10 transition-colors"
            :class="selectedIds.size > 0 ? 'bg-primary-50' : 'bg-background'"
          >
            <div class="flex items-center justify-center py-2">
              <input
                ref="headerCheckboxRef"
                type="checkbox"
                :checked="allSelected"
                @change="toggleSelectAll"
                class="w-3.5 h-3.5 accent-primary-500 cursor-pointer"
              />
            </div>
            <!-- Column labels -->
            <template v-if="selectedIds.size === 0">
              <div class="py-2 text-[11px] font-medium text-neutral uppercase tracking-wider">
                <template v-if="hasSearched">
                  {{ total }} result{{ total !== 1 ? "s" : "" }}
                  <span v-if="activeFilters.length > 0" class="normal-case tracking-normal opacity-70">
                    · {{ activeFilters.length }} filter{{ activeFilters.length !== 1 ? "s" : "" }}
                  </span>
                </template>
                <template v-else>
                  {{ allDocuments.length }} document{{ allDocuments.length !== 1 ? "s" : "" }}
                  <span v-if="documentsData?.pages[0]" class="normal-case tracking-normal opacity-70">
                    · {{ documentsData.pages[0].total }} total
                  </span>
                </template>
              </div>
              <div class="py-2 text-[11px] font-medium text-neutral uppercase tracking-wider">Properties</div>
              <div class="py-2 pr-4 text-right text-[11px] font-medium text-neutral uppercase tracking-wider">Modified</div>
            </template>
            <!-- Batch toolbar -->
            <div v-else class="col-span-3 flex items-center gap-2 py-2 pr-4">
              <span class="text-size-small font-medium text-primary-700">{{ selectedIds.size }} selected</span>
              <button @click="deselectAll" class="p-0.5 text-neutral hover:text-neutral-800 hover:bg-neutral-200 rounded-sm transition-colors">
                <div class="svg-icon w-3.5 h-3.5" v-html="closeXIcon" />
              </button>
              <div class="flex-1" />
              <button
                v-if="userCanEdit"
                @click="batchArchive"
                :disabled="isBatchArchiving"
                class="flex items-center gap-1.5 px-3 py-1 bg-background border border-neutral-100 rounded-md text-size-small text-neutral-700 hover:border-neutral-300 hover:text-neutral-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <div class="svg-icon w-3.5 h-3.5" v-html="archiveIcon" />
                {{ isBatchArchiving ? "Archiving…" : "Archive" }}
              </button>
            </div>
          </div>

          <!-- Search results: flat ranked list (only when text query present) -->
          <template v-if="hasSearched && committedQuery.trim()">
            <DocumentListItem
              v-for="result in sortedResults"
              :key="result.id"
              :document="result"
              :space-slug="props.spaceSlug"
              :show-snippet="true"
              :search-query="searchQuery"
              :selected="selectedIds.has(result.id)"
              :selectable="selectedIds.size > 0"
              @toggle-select="toggleSelect"
            />

            <!-- Pagination -->
            <div v-if="totalPages > 1" class="flex justify-between items-center mt-8 pt-5 border-t border-neutral-100">
              <button
                @click="handlePrevPage"
                :disabled="!hasPrevPage || isFetchingSearch"
                class="flex items-center gap-2 px-4 py-2 bg-background border border-neutral-100 rounded-lg font-medium text-size-medium hover:bg-neutral-50 hover:border-primary-300 hover:text-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <div class="svg-icon w-4 h-4" v-html="chevronLeftLargeIcon" />
                Previous
              </button>
              <span class="text-size-medium text-neutral-500">
                Page <span class="font-semibold">{{ page }}</span> of
                <span class="font-semibold">{{ totalPages }}</span>
              </span>
              <button
                @click="handleNextPage"
                :disabled="!hasNextPage || isFetchingSearch"
                class="flex items-center gap-2 px-4 py-2 bg-background border border-neutral-100 rounded-lg font-medium text-size-medium hover:bg-neutral-50 hover:border-primary-300 hover:text-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Next
                <div class="svg-icon w-4 h-4" v-html="chevronRightThinIcon" />
              </button>
            </div>
          </template>

          <!-- Browse mode: grouped list -->
          <template v-else>
            <template v-for="(docs, groupKey) in groupedDocuments" :key="groupKey">
              <div v-if="docs.length > 0" class="mb-8">
                <div class="px-8 py-1.5 text-[11px] font-medium text-neutral uppercase tracking-wider bg-neutral-50 border-b border-neutral-100">
                  {{ groupKey === "thisWeek" ? "This Week" : groupKey === "thisMonth" ? "This Month" : groupKey }}
                </div>
                <DocumentListItem
                  v-for="doc in docs"
                  :key="doc.id"
                  :document="doc"
                  :space-slug="props.spaceSlug"
                  :selected="selectedIds.has(doc.id)"
                  :selectable="selectedIds.size > 0"
                  @toggle-select="toggleSelect"
                />
              </div>
            </template>

            <div v-if="hasMoreDocuments" class="flex justify-center mt-6 pt-6 border-t border-neutral-100">
              <button
                @click="() => fetchNextPage()"
                :disabled="isFetchingNextPage"
                class="flex items-center gap-2 px-5 py-2 bg-background border border-neutral-100 rounded-lg font-medium text-size-medium hover:border-primary-300 hover:text-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <div v-if="isFetchingNextPage" class="svg-icon w-4 h-4 animate-spin" v-html="spinnerIcon" />
                {{ isFetchingNextPage ? "Loading…" : "Load more" }}
              </button>
            </div>
          </template>
        </div>

        <!-- No search results -->
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

        <!-- Loading documents -->
        <div v-else-if="!hasSearched && isLoadingDocuments" class="text-center py-12">
          <div class="svg-icon w-10 h-10 mx-auto mb-4 text-neutral-300 animate-spin" v-html="spinnerIcon" />
          <p class="text-size-medium text-neutral-500">Loading documents…</p>
        </div>

        <!-- No documents yet -->
        <div v-else-if="!hasSearched && !isLoadingDocuments" class="text-center py-12">
          <div class="svg-icon w-12 h-12 mx-auto mb-4 text-neutral-300" v-html="documentIcon" />
          <h3 class="text-size-large font-semibold text-neutral-700 mb-2">No documents yet</h3>
          <p class="text-neutral-500 text-size-medium">There are no documents in this space yet</p>
        </div>

      </div>
    </div>
  </div>
</template>
