<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  closeCircleFilledIcon,
  closeXIcon,
  documentIcon,
  searchMagnifierIcon,
  spinnerIcon,
} from "~/src/assets/icons.ts";
import {
  api,
  type PropertyFilter,
} from "../api/client.ts";
import { useInfiniteQuery } from "../composeables/query.ts";
import { usePagedList } from "../composeables/usePagedList.ts";
import { canEdit } from "../composeables/usePermissions.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { replaceBrowserUrl } from "../utils/browserHistory.ts";
import DocumentGroupedList from "./DocumentGroupedList.vue";
import Pager from "./Pager.vue";
import SearchFilters from "./SearchFilters.vue";

const props = defineProps<{
  spaceId: string;
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
  goToPage: handleGoToPage,
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
  replaceBrowserUrl(url);
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
  queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
    return await api.documents.get(props.spaceId, {
      limit: documentsPageSize,
      cursor: pageParam,
    });
  },
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  initialPageParam: undefined,
});

// Flatten all documents from pages (only when not searching)
const allDocuments = computed(() => {
  if (hasSearched.value) return [];
  if (!documentsData.value) return [];
  return documentsData.value.pages.flatMap((page) => page.documents);
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
  committedQuery.value = "";
  if (activeFilters.value.length > 0) {
    committedFilters.value = [...activeFilters.value];
    hasSearched.value = true;
  } else {
    hasSearched.value = false;
    committedFilters.value = [];
  }
  updateUrlParams();
};

const clearAll = () => {
  clear();
  activeFilters.value = [];
  committedFilters.value = [];
  hasSearched.value = false;
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

// Batch operations
const isBatchArchiving = ref(false);

const batchArchive = async (ids: string[]) => {
  const count = ids.length;
  if (!confirm(`Archive ${count} document${count !== 1 ? "s" : ""}?`)) return;

  isBatchArchiving.value = true;
  try {
    for (const id of ids) {
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
    <div class="flex gap-3 mb-3">
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

    <!-- Filter chips row -->
    <div class="mb-6">
      <SearchFilters
        :spaceId="props.spaceId"
        v-model="activeFilters"
        @search="handleSearch"
      />
    </div>

    <!-- Error Message -->
    <div v-if="searchError" class="flex items-center gap-3 p-4 mb-6 bg-red-50 text-red-800 border border-red-200 rounded-lg text-size-medium">
      <div class="svg-icon w-5 h-5 shrink-0" v-html="closeCircleFilledIcon" />
      {{ searchError.message ?? "Search failed" }}
    </div>

    <!-- Browse mode: grouped document list -->
    <template v-if="!hasSearched">
      <DocumentGroupedList
        v-if="allDocuments.length > 0"
        :items="allDocuments"
        :show-toolbar="false"
        empty-text="No documents yet"
      >
        <template v-if="userCanEdit" #batch-actions="{ selectedIds, deselectAll }">
          <button
            @click="batchArchive([...selectedIds]); deselectAll()"
            :disabled="isBatchArchiving"
            class="px-3 py-1.5 text-size-small font-medium border border-neutral-200 rounded-md text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {{ isBatchArchiving ? "Archiving…" : "Archive selected" }}
          </button>
        </template>
      </DocumentGroupedList>

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

    <!-- Search results: grouped list -->
    <template v-else-if="sortedResults.length > 0">
      <DocumentGroupedList
        :items="sortedResults as any"
        :show-toolbar="false"
      >
        <template v-if="userCanEdit" #batch-actions="{ selectedIds, deselectAll }">
          <button
            @click="batchArchive([...selectedIds]); deselectAll()"
            :disabled="isBatchArchiving"
            class="px-3 py-1.5 text-size-small font-medium border border-neutral-200 rounded-md text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {{ isBatchArchiving ? "Archiving…" : "Archive selected" }}
          </button>
        </template>
      </DocumentGroupedList>

      <Pager
        class="mt-6 pt-5"
        :page="page"
        :total-pages="totalPages"
        :disabled="isFetchingSearch"
        @change="handleGoToPage"
      />
    </template>

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
</template>
