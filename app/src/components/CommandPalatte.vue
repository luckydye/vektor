<script setup>
import { ref, computed, watch, nextTick, onMounted } from "vue";
import { useDocuments } from "../composeables/useDocuments.ts";
import { useRoute } from "../composeables/useRoute.ts";
import { Actions } from "../utils/actions.ts";
import { history } from "../utils/history.ts";
import { formatRelativeTime } from "../utils/utils.ts";
import { twMerge } from "tailwind-merge";

const { documents } = useDocuments();
const { spaceSlug } = useRoute();

const isOpen = ref(false);
const searchQuery = ref("");
const selectedIndex = ref(0);
const searchInput = ref(null);
const resultsContainer = ref(null);
const historyEntries = ref([]);

const getLastVisited = (doc) => {
  const url = `/${spaceSlug.value}/doc/${doc.slug}`;
  const entry = historyEntries.value.find((h) => h.url === url);
  return entry ? entry.lastVisited : null;
};

// Combined search results: documents + actions
const filteredResults = computed(() => {
  const query = searchQuery.value.toLowerCase().trim();
  const results = [];

  // Add matching documents
  let docs = documents.value;
  if (query) {
    docs = docs.filter((doc) => {
      const title = doc.properties?.title?.toLowerCase() || "untitled";
      const slug = doc.slug?.toLowerCase() || "";
      return title.includes(query) || slug.includes(query);
    });
  }

  // Sort documents by recency from history
  const sortedDocs = [...docs].sort((a, b) => {
    const aUrl = `/${spaceSlug.value}/doc/${a.slug}`;
    const bUrl = `/${spaceSlug.value}/doc/${b.slug}`;
    const aHistory = historyEntries.value.find((entry) => entry.url === aUrl);
    const bHistory = historyEntries.value.find((entry) => entry.url === bUrl);
    if (aHistory && bHistory) return bHistory.lastVisited - aHistory.lastVisited;
    if (aHistory) return -1;
    if (bHistory) return 1;
    return 0;
  });

  for (const doc of sortedDocs) {
    results.push({ type: "document", data: doc });
  }

  // Add matching actions
  for (const [id, action] of Actions.entries()) {
    // Skip the palette toggle action itself
    if (id === "ui:toggle:palatte") continue;

    const matchesQuery = !query || Actions.rank(id, query) > 0;
    if (matchesQuery) {
      results.push({ type: "action", id, data: action });
    }
  }

  return results;
});

const loadHistory = async () => {
  try {
    historyEntries.value = await history.getAll();
    console.log("Loaded history entries:", historyEntries.value);
  } catch (error) {
    console.error("Failed to load history:", error);
    historyEntries.value = [];
  }
};

const togglePalette = async () => {
  isOpen.value = !isOpen.value;
  if (isOpen.value) {
    loadHistory();
    nextTick(() => searchInput.value?.focus());
  }
};

const closePalette = () => {
  isOpen.value = false;
  searchQuery.value = "";
  selectedIndex.value = 0;
};

const handleArrowDown = () => {
  if (selectedIndex.value < filteredResults.value.length - 1) {
    selectedIndex.value++;
    scrollToSelected();
  }
};

const handleArrowUp = () => {
  if (selectedIndex.value > 0) {
    selectedIndex.value--;
    scrollToSelected();
  }
};

const handleEnter = () => {
  const selected = filteredResults.value[selectedIndex.value];
  if (selected) {
    if (selected.type === "document") {
      navigateToDocument(selected.data);
    } else if (selected.type === "action") {
      executeAction(selected.id);
    }
  }
};

const scrollToSelected = () => {
  nextTick(() => {
    const selectedElement = resultsContainer.value?.children[selectedIndex.value];
    if (selectedElement) {
      selectedElement.scrollIntoView({ block: "nearest" });
    }
  });
};

const navigateToDocument = async (doc) => {
  if (doc && doc.slug) {
    const url = `/${spaceSlug.value}/doc/${doc.slug}`;
    const title = doc.properties?.title || "Untitled Document";

    try {
      await history.log(url, title);
    } catch (error) {
      console.error("Failed to log history:", error);
    }

    window.location.href = url;
  }
  closePalette();
};

const executeAction = (actionId) => {
  closePalette();
  Actions.run(actionId);
};

const handleResultKeydown = (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    handleArrowDown();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    handleArrowUp();
  } else if (event.key === "Enter") {
    event.preventDefault();
    handleEnter();
  }
};

watch(searchQuery, () => {
  selectedIndex.value = 0;
});

Actions.register("ui:toggle:palatte", {
  title: "Toggle Command Palatte",
  description: "Open or close the command menu",
  group: "navigation",
  run: async () => {
    togglePalette();
  },
});
</script>

<template>
  <div>
    <Transition name="fade">
      <a-blur
        v-if="isOpen"
        enabled
        class="fixed inset-0 bg-black/50 z-50 flex items-start justify-center pt-32"
        @click="closePalette"
        @exit="closePalette"
      >
        <div
          class="bg-background rounded-lg shadow-2xl w-full max-w-[800px] mx-4 overflow-hidden"
          @click.stop
        >
          <div class="p-4 border-b border-neutral-100">
            <div class="flex items-center gap-3">
              <svg
                class="w-5 h-5 text-neutral"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                ref="searchInput"
                v-model="searchQuery"
                type="text"
                placeholder="Find documents..."
                class="flex-1 outline-none text-neutral-900 text-lg"
                @keydown="handleResultKeydown"
              />
              <kbd
                class="hidden sm:inline-block px-2 py-1 text-xs font-semibold text-neutral-900 neutral border border-neutral-100 rounded"
              >
                ESC
              </kbd>
            </div>
          </div>

          <div
            ref="resultsContainer"
            class="max-h-96 overflow-y-auto"
          >
            <div v-if="filteredResults.length === 0" class="p-8 text-center text-neutral">
              <svg
                class="w-12 h-12 mx-auto mb-3 text-neutral"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <p class="text-sm">No results found, mate</p>
            </div>

            <button
              v-for="(result, index) in filteredResults"
              :key="result.type === 'document' ? 'doc-' + result.data.id : 'action-' + result.id"
              class="w-full text-left px-4 py-3 hover:bg-neutral-300 border-b border-neutral-100 last:border-b-0 flex items-center justify-between gap-3"
              :class="{
                'bg-neutral-50 hover:bg-neutral-50': index === selectedIndex,
              }"
              @click="result.type === 'document' ? navigateToDocument(result.data) : executeAction(result.id)"
              @mouseenter="selectedIndex = index"
            >
              <div class="flex items-center gap-3 flex-1 min-w-0">
                <!-- Document icon -->
                <svg
                  v-if="result.type === 'document'"
                  class="w-5 h-5 flex-shrink-0"
                  :class="index === selectedIndex ? 'text-neutral-600' : 'text-neutral-400'"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
                <!-- Action icon -->
                <svg
                  v-else
                  class="w-5 h-5 flex-shrink-0"
                  :class="index === selectedIndex ? 'text-neutral-600' : 'text-neutral-400'"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  />
                </svg>
                <div class="flex-1 min-w-0">
                  <!-- Document content -->
                  <template v-if="result.type === 'document'">
                    <p class="font-medium truncate text-neutral-900">
                      {{ result.data.properties?.title || "Untitled Document" }}
                    </p>
                    <p class="text-xs text-neutral-900 truncate flex items-center gap-2">
                      <span>/{{ result.data.slug }}</span>
                      <span v-if="getLastVisited(result.data)" class="text-neutral">
                        • {{ formatRelativeTime(getLastVisited(result.data)) }}
                      </span>
                    </p>
                  </template>
                  <!-- Action content -->
                  <template v-else>
                    <p class="font-medium truncate text-neutral-900">
                      {{ result.data.title || result.id }}
                    </p>
                    <p class="text-xs text-neutral truncate flex items-center gap-2">
                      <span v-if="result.data.description">{{ result.data.description }}</span>
                    </p>
                  </template>
                </div>

                <kbd
                  v-for="shortcut in Actions.getShortcutsForAction(result.id)"
                  :key="shortcut"
                  class="px-1.5 py-0.5 bg-neutral-100 border border-neutral-100 rounded font-mono text-[10px] capitalize"
                >
                  {{ shortcut }}
                </kbd>
              </div>
              <svg
                :class="twMerge(
                  'w-4 h-4 text-neutral flex-none invisible',
                  index === selectedIndex && 'visible'
                )"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </button>
          </div>

          <div class="px-4 py-3 bg-neutral-100 border-t border-neutral-100 flex items-center justify-between text-xs text-neutral">
            <div class="flex items-center gap-4">
              <span class="flex items-center gap-1">
                <kbd class="px-1.5 py-0.5 bg-background border border-neutral-100 rounded font-mono">↑↓</kbd>
                Navigate
              </span>
              <span class="flex items-center gap-1">
                <kbd class="px-1.5 py-0.5 bg-background border border-neutral-100 rounded font-mono">Enter</kbd>
                Select
              </span>
            </div>
            <span class="flex items-center gap-1">
              <kbd class="px-1.5 py-0.5 bg-background border border-neutral-100 rounded font-mono">⌘K</kbd>
              Toggle
            </span>
          </div>
        </div>
      </a-blur>
    </Transition>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
</style>
