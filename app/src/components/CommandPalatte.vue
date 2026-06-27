<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import {
  boltIcon,
  chevronRightThinIcon,
  documentIcon,
  searchMagnifierIcon,
} from "~/src/assets/icons.ts";
import { useDocuments } from "../composeables/useDocuments.ts";
import { Actions } from "../utils/actions.ts";
import { history } from "../utils/history.ts";
import { formatRelativeTime } from "../utils/utils.ts";

const router = useRouter();
const { documents } = useDocuments();


const isOpen = ref(false);
const searchQuery = ref("");
const selectedIndex = ref(0);
const searchInput = ref(null);
const resultsContainer = ref(null);
const historyEntries = ref([]);

const getLastVisited = (doc) => {
  const url = `/doc/${doc.slug}`;
  const entry = historyEntries.value.find((h) => h.url === url);
  return entry ? entry.lastVisited : null;
};

const filteredResults = computed(() => {
  const query = searchQuery.value.toLowerCase().trim();
  const results = [];

  let docs = documents.value;
  if (query) {
    docs = docs.filter((doc) => {
      const title = doc.properties?.title?.toLowerCase() || "untitled";
      const slug = doc.slug?.toLowerCase() || "";
      return title.includes(query) || slug.includes(query);
    });
  }

  const sortedDocs = [...docs].sort((a, b) => {
    const aUrl = `/doc/${a.slug}`;
    const bUrl = `/doc/${b.slug}`;
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

  for (const [id, action] of Actions.entries()) {
    if (id === "ui:toggle:palatte") continue;
    const matchesQuery = !query || Actions.rank(id, query) > 0;
    if (matchesQuery) {
      results.push({ type: "action", id, data: action });
    }
  }

  return results;
});

// First index of each section (for section headers)
const firstActionIndex = computed(() =>
  filteredResults.value.findIndex((r) => r.type === "action"),
);
const hasDocuments = computed(() =>
  filteredResults.value.some((r) => r.type === "document"),
);
const hasActions = computed(() => filteredResults.value.some((r) => r.type === "action"));

const loadHistory = async () => {
  try {
    historyEntries.value = await history.getAll();
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
    const el = resultsContainer.value?.querySelector(
      `[data-result-index="${selectedIndex.value}"]`,
    );
    if (el) el.scrollIntoView({ block: "nearest" });
  });
};

const navigateToDocument = async (doc) => {
  if (doc?.slug) {
    const url = `/doc/${doc.slug}`;
    const title = doc.properties?.title || "Untitled Document";
    try {
      await history.log(url, title);
    } catch (error) {
      console.error("Failed to log history:", error);
    }
    if (url.startsWith("/") && !url.startsWith("//")) {
      router.push(url);
    } else {
      window.location.href = url;
    }
  }
  closePalette();
};

const executeAction = (actionId) => {
  closePalette();
  Actions.run(actionId);
};

const handleKeydown = (event) => {
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
        class="fixed inset-0 bg-black/30 z-50 flex items-start justify-center pt-[15vh]"
        @click="closePalette"
        @exit="closePalette"
      >
        <div
          class="bg-background border border-neutral-100 rounded-xl shadow-2xl w-full max-w-[640px] mx-4 overflow-hidden"
          @click.stop
        >
          <!-- Search input -->
          <div class="flex items-center gap-3 px-4 py-3 border-b border-neutral-100">
            <div class="svg-icon w-4 h-4 text-neutral flex-none" v-html="searchMagnifierIcon" />
            <input
              ref="searchInput"
              v-model="searchQuery"
              type="text"
              placeholder="Search documents and actions…"
              class="flex-1 outline-none bg-transparent text-neutral-900 text-size-medium placeholder:text-neutral"
              @keydown="handleKeydown"
            />
            <kbd class="hidden sm:inline-block px-1.5 py-0.5 text-[11px] text-neutral border border-neutral-100 rounded-sm font-mono">
              ESC
            </kbd>
          </div>

          <!-- Results -->
          <div ref="resultsContainer" class="overflow-y-auto max-h-[400px] py-1">
            <!-- Empty state -->
            <div v-if="filteredResults.length === 0" class="px-4 py-10 text-center">
              <p class="text-size-medium text-neutral">No results found</p>
            </div>

            <template v-for="(result, index) in filteredResults" :key="result.type === 'document' ? 'doc-' + result.data.id : 'action-' + result.id">
              <!-- Section header -->
              <div
                v-if="(index === 0 && result.type === 'document') || (result.type === 'action' && index === firstActionIndex)"
                class="px-3 pt-2 pb-0.5"
              >
                <span class="text-[11px] font-medium text-neutral uppercase tracking-wider">
                  {{ result.type === "document" ? "Documents" : "Actions" }}
                </span>
              </div>

              <!-- Item -->
              <component
                :is="result.type === 'document' ? 'page-target' : 'div'"
                v-bind="result.type === 'document' ? { 'data-document-id': result.data.id } : {}"
                class="block px-1 [&[data-dragging]]:opacity-50"
                @document-drag-start="closePalette"
              >
                <button
                  :data-result-index="index"
                  class="w-full text-left px-3xs rounded-md min-h-[36px] flex items-center gap-2.5 text-neutral-800"
                  :class="[
                    index === selectedIndex ? 'bg-primary-100 text-primary-700' : 'hover:bg-primary-50',
                    result.type === 'document' ? 'cursor-grab active:cursor-grabbing' : '',
                  ]"
                  @click="result.type === 'document' ? navigateToDocument(result.data) : executeAction(result.id)"
                  @mouseenter="selectedIndex = index"
                >
                  <div
                    class="svg-icon icon w-4 h-4 flex-none"
                    :class="index === selectedIndex ? 'text-primary-600' : 'text-neutral-400'"
                    v-html="result.type === 'document' ? documentIcon : boltIcon"
                  />
                  <div class="flex-1 min-w-0 flex items-center gap-2">
                    <span class="text-size-medium truncate font-normal">
                      {{ result.type === "document"
                        ? (result.data.properties?.title || "Untitled Document")
                        : (result.data.title || result.id) }}
                    </span>
                    <span
                      v-if="result.type === 'document' && getLastVisited(result.data)"
                      class="text-size-small text-neutral flex-none"
                    >
                      {{ formatRelativeTime(getLastVisited(result.data)) }}
                    </span>
                    <span
                      v-if="result.type === 'action' && result.data.description"
                      class="text-size-small text-neutral truncate"
                    >
                      {{ result.data.description }}
                    </span>
                  </div>
                  <div class="flex items-center gap-1 flex-none">
                    <kbd
                      v-for="shortcut in Actions.getShortcutsForAction(result.id)"
                      :key="shortcut"
                      class="px-1.5 py-0.5 bg-neutral-100 border border-neutral-100 rounded-sm font-mono text-[10px] capitalize"
                    >
                      {{ shortcut }}
                    </kbd>
                  </div>
                  <div
                    class="svg-icon w-3.5 h-3.5 text-neutral flex-none transition-opacity"
                    :class="index === selectedIndex ? 'opacity-100' : 'opacity-0'"
                    v-html="chevronRightThinIcon"
                  />
                </button>
              </component>
            </template>
          </div>

          <!-- Footer -->
          <div class="px-4 py-2 bg-neutral-50 border-t border-neutral-100 flex items-center justify-between text-[11px] text-neutral rounded-b-xl">
            <div class="flex items-center gap-3">
              <span class="flex items-center gap-1">
                <kbd class="px-1.5 py-0.5 bg-background border border-neutral-100 rounded-sm font-mono">↑↓</kbd>
                Navigate
              </span>
              <span class="flex items-center gap-1">
                <kbd class="px-1.5 py-0.5 bg-background border border-neutral-100 rounded-sm font-mono">↵</kbd>
                Select
              </span>
            </div>
            <span class="flex items-center gap-1">
              <kbd class="px-1.5 py-0.5 bg-background border border-neutral-100 rounded-sm font-mono">⌘K</kbd>
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
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
</style>
