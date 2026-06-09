<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { arrowDownTrayIcon } from "~/src/assets/icons.ts";

const PAGE_SIZE = 10;
const DEFAULT_COL_WIDTH = 200;

const props = defineProps<{
  data: Record<string, unknown>[];
  spaceSlug: string;
  documentId?: string;
}>();

const filter = ref("");
const page = ref(0);
const sortCol = ref<string | null>(null);
const sortAsc = ref(true);
const focusedRow = ref<number | null>(null);

watch(filter, () => {
  page.value = 0;
});

function toggleSort(col: string) {
  if (sortCol.value === col) {
    sortAsc.value = !sortAsc.value;
  } else {
    sortCol.value = col;
    sortAsc.value = true;
  }
  page.value = 0;
}

const columns = computed(() => {
  if (props.data.length === 0) return [];
  return Object.keys(props.data[0]);
});

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  let rows = q
    ? props.data.filter((row) =>
        Object.values(row).some((v) =>
          String(v ?? "")
            .toLowerCase()
            .includes(q),
        ),
      )
    : props.data;
  if (sortCol.value) {
    const col = sortCol.value;
    const asc = sortAsc.value ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const av = a[col] ?? "";
      const bv = b[col] ?? "";
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * asc;
      return String(av).localeCompare(String(bv)) * asc;
    });
  }
  return rows;
});

const pageCount = computed(() =>
  Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)),
);
const paginated = computed(() =>
  filtered.value.slice(page.value * PAGE_SIZE, (page.value + 1) * PAGE_SIZE),
);

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function downloadCsv() {
  const csvCols = columns.value;
  const escapeCsv = (s: string) =>
    s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  const header = csvCols.map(escapeCsv).join(",");
  const rows = filtered.value.map((row) =>
    csvCols.map((col) => escapeCsv(cellText(row[col]))).join(","),
  );
  const blob = new Blob([`${header}\n${rows.join("\n")}`], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "data.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

function isDocumentIdColumn(column: string): boolean {
  return column.toLowerCase().includes("documentid");
}

function documentHref(column: string, value: unknown): string | null {
  if (!isDocumentIdColumn(column)) return null;
  const text = cellText(value).trim();
  if (!text) return null;
  return `/${props.spaceSlug}/doc/${encodeURIComponent(text)}`;
}

// Column resizing
const storageKey = computed(() =>
  props.documentId ? `datatable-col-widths-${props.documentId}` : null,
);
const columnWidths = ref<Record<string, number>>({});

onMounted(() => {
  if (!storageKey.value) return;
  try {
    const saved = sessionStorage.getItem(storageKey.value);
    if (saved) columnWidths.value = JSON.parse(saved);
  } catch {}
});

function colWidth(col: string): string {
  return `${columnWidths.value[col] ?? DEFAULT_COL_WIDTH}px`;
}

let resizeCol: string | null = null;
let resizeStartX = 0;
let resizeStartWidth = 0;

function onResizeMouseDown(col: string, e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  resizeCol = col;
  resizeStartX = e.clientX;
  resizeStartWidth = columnWidths.value[col] ?? DEFAULT_COL_WIDTH;
  document.addEventListener("mousemove", onResizeMouseMove);
  document.addEventListener("mouseup", onResizeMouseUp);
}

function onResizeMouseMove(e: MouseEvent) {
  if (!resizeCol) return;
  const newWidth = Math.max(80, resizeStartWidth + (e.clientX - resizeStartX));
  columnWidths.value = { ...columnWidths.value, [resizeCol]: newWidth };
}

function onResizeMouseUp() {
  resizeCol = null;
  document.removeEventListener("mousemove", onResizeMouseMove);
  document.removeEventListener("mouseup", onResizeMouseUp);
  if (storageKey.value) {
    sessionStorage.setItem(storageKey.value, JSON.stringify(columnWidths.value));
  }
}

onUnmounted(() => {
  document.removeEventListener("mousemove", onResizeMouseMove);
  document.removeEventListener("mouseup", onResizeMouseUp);
});
</script>

<template>
  <div class="space-y-2">
    <input
      v-model="filter"
      type="text"
      placeholder="Filter…"
      class="w-full rounded-md border border-neutral-200 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-400"
    />
    <div class="overflow-x-auto rounded-lg border border-neutral-200">
      <table class="text-sm" style="table-layout: fixed;">
        <thead>
          <tr class="bg-neutral-50 dark:bg-neutral-800 text-left">
            <th
              v-for="col in columns"
              :key="col"
              class="relative px-3 py-2 text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide whitespace-nowrap border-b border-neutral-200 cursor-pointer select-none hover:text-neutral-700 dark:hover:text-neutral-200 overflow-hidden"
              :style="{ width: colWidth(col) }"
              @click="toggleSort(col)"
            >
              <span class="inline-flex items-center gap-1 truncate">
                {{ col }}
                <span class="opacity-50 shrink-0">
                  <template v-if="sortCol === col">{{ sortAsc ? "↑" : "↓" }}</template>
                  <template v-else>↕</template>
                </span>
              </span>
              <!-- Resize handle -->
              <div
                class="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-neutral-300 dark:hover:bg-neutral-600 active:bg-neutral-400"
                @mousedown.stop="onResizeMouseDown(col, $event)"
              />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, i) in paginated"
            :key="i"
            tabindex="0"
            class="border-b border-neutral-100 dark:border-neutral-800 last:border-0 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors outline-none cursor-pointer"
            :class="focusedRow === i ? 'bg-sky-50 dark:bg-sky-900/20 ring-1 ring-inset ring-sky-300 dark:ring-sky-700' : ''"
            @focus="focusedRow = i"
            @blur="focusedRow = null"
            @click="focusedRow = i"
          >
            <td
              v-for="col in columns"
              :key="col"
              class="px-3 py-2 text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap overflow-hidden truncate"
              :style="{ width: colWidth(col), maxWidth: colWidth(col) }"
              :title="cellText(row[col])"
            >
              <a
                v-if="documentHref(col, row[col])"
                :href="documentHref(col, row[col])!"
                class="text-sky-700 hover:text-sky-800 hover:underline"
                target="_blank"
                rel="noreferrer"
              >{{ cellText(row[col]) }}</a>
              <template v-else>{{ cellText(row[col]) }}</template>
            </td>
          </tr>
          <tr v-if="filtered.length === 0">
            <td :colspan="columns.length" class="px-3 py-4 text-center text-xs text-neutral-400">No results</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="flex items-center justify-between text-xs text-neutral-400">
      <div class="flex items-center gap-2">
        <span>{{ filtered.length }} / {{ data.length }} rows</span>
        <button
          class="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-neutral-200 hover:bg-neutral-50 transition-colors"
          title="Download as CSV"
          @click="downloadCsv"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="arrowDownTrayIcon" />
          CSV
        </button>
      </div>
      <div v-if="pageCount > 1" class="flex items-center gap-1">
        <button
          class="px-2 py-0.5 rounded border border-neutral-200 hover:bg-neutral-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          :disabled="page === 0"
          @click="page--"
        >←</button>
        <span>{{ page + 1 }} / {{ pageCount }}</span>
        <button
          class="px-2 py-0.5 rounded border border-neutral-200 hover:bg-neutral-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          :disabled="page >= pageCount - 1"
          @click="page++"
        >→</button>
      </div>
    </div>
  </div>
</template>
