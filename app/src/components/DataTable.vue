<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { arrowDownTrayIcon } from "~/src/assets/icons.ts";
import { downloadExcelSheets, sanitizeSheetName } from "../utils/excelExport.ts";
import type { ExcelSheet } from "../utils/excelExport.ts";
import ExcelExportDialog from "./ExcelExportDialog.vue";
import type { ExcelExportConfig } from "./ExcelExportDialog.vue";
import { useSpace } from "../composeables/useSpace.ts";
import { spacePath } from "../utils/utils.ts";

const { currentSpace } = useSpace();

const PAGE_SIZE = 10;
const DEFAULT_COL_WIDTH = 200;

const props = defineProps<{
  data: Record<string, unknown>[];
  documentId?: string;
  exportFileName?: string;
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

const showExportDialog = ref(false);

function downloadExcel() {
  showExportDialog.value = true;
}

function parseBoldSection(text: string): Record<string, string> | null {
  // Match **Heading** followed by its content up to the next **Heading** or end
  const regex = /\*\*([^*\n]+)\*\*\s*\n?([\s\S]*?)(?=\n\*\*[^*\n]+\*\*|$)/g;
  const result: Record<string, string> = {};
  let found = false;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    found = true;
    result[match[1].trim()] = match[2].trim();
  }
  return found ? result : null;
}

function buildSubSheetRows(sections: string[], parseBold: boolean): string[][] {
  if (!parseBold) return sections.map((s) => [s]);

  // The 0th section is an intro/summary block (e.g. "Notiz"), not a record — skip it.
  const recordSections = sections.slice(1);

  const parsed = recordSections.map(parseBoldSection).filter((r): r is Record<string, string> => r !== null);
  if (parsed.length === 0) return recordSections.map((s) => [s]);

  // Union of all keys in order of first appearance
  const keyOrder: string[] = [];
  const keySet = new Set<string>();
  for (const record of parsed) {
    for (const k of Object.keys(record)) {
      if (!keySet.has(k)) { keySet.add(k); keyOrder.push(k); }
    }
  }

  return [keyOrder, ...parsed.map((r) => keyOrder.map((k) => r[k] ?? ""))];
}

function handleExportDownload(config: ExcelExportConfig) {
  showExportDialog.value = false;
  const tableColumns = columns.value;

  const overviewRows = [
    tableColumns,
    ...filtered.value.map((row) => tableColumns.map((col) => cellText(row[col]))),
  ];

  const sheets: ExcelSheet[] = [{ name: "Overview", rows: overviewRows }];
  const usedNames = new Set(["Overview"]);

  for (let i = 0; i < filtered.value.length; i++) {
    const row = filtered.value[i];

    let baseName = sanitizeSheetName(cellText(row[config.sheetNameColumn]).trim()) || `Row ${i + 1}`;
    if (baseName.length > 28) baseName = baseName.slice(0, 28);
    let sheetName = baseName;
    let n = 2;
    while (usedNames.has(sheetName)) {
      sheetName = `${baseName.slice(0, 25)} ${n++}`;
    }
    usedNames.add(sheetName);

    const content = cellText(row[config.splitColumn]);
    const del = config.delimiter.trim();
    const sections = del
      ? content.split(del).map((s) => s.trim()).filter(Boolean)
      : [content];

    const summaryCols = tableColumns.slice(0, 4);
    const summaryRows = summaryCols.map((col) => [col, cellText(row[col])]);
    const subRows = buildSubSheetRows(sections, config.parseBoldHeadings);

    sheets.push({ name: sheetName, rows: [...summaryRows, [], ...subRows] });
  }

  downloadExcelSheets(sheets, props.exportFileName ?? "data.xlsx");
}

function isDocumentIdColumn(column: string): boolean {
  return column.toLowerCase().includes("documentid");
}

function documentHref(column: string, value: unknown): string | null {
  if (!isDocumentIdColumn(column)) return null;
  const text = cellText(value).trim();
  if (!text) return null;
  return spacePath(currentSpace.value?.slug, `/doc/${encodeURIComponent(text)}`);
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
  <div>
    <ExcelExportDialog
      v-if="showExportDialog"
      :columns="columns"
      :row-count="filtered.length"
      @cancel="showExportDialog = false"
      @download="handleExportDownload"
    />
    <div
      class="flex items-center gap-3 h-9 border-b border-neutral-100 bg-neutral-50 px-4"
    >
      <input
        v-model="filter"
        type="text"
        placeholder="Filter…"
        class="min-w-0 flex-1 bg-transparent text-size-medium text-neutral-800 placeholder:text-neutral-400 focus:outline-none"
      />
      <div class="flex items-center gap-2 text-size-small text-neutral-400 shrink-0">
        <span>{{ filtered.length }} / {{ data.length }} rows</span>
        <button
          class="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm border border-neutral-200 bg-background hover:bg-neutral-50 hover:border-neutral-300 text-neutral-600 transition-colors"
          title="Download as Excel"
          @click="downloadExcel"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="arrowDownTrayIcon" />
          Excel
        </button>
      </div>
    </div>
    <div class="overflow-x-auto">
      <table class="text-size-medium" style="table-layout: fixed; width: max-content; min-width: 100%;">
        <thead>
          <tr class="bg-neutral-50 text-left">
            <th
              v-for="col in columns"
              :key="col"
              class="relative px-4 py-2 text-size-small font-medium text-neutral-500 uppercase tracking-wide whitespace-nowrap border-b border-neutral-100 cursor-pointer select-none hover:text-neutral-700 overflow-hidden"
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
                class="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-neutral-300 active:bg-neutral-400"
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
            class="border-b border-neutral-100 hover:bg-neutral-50 transition-colors outline-none cursor-pointer"
            :class="focusedRow === i ? 'bg-primary-50' : ''"
            @focus="focusedRow = i"
            @blur="focusedRow = null"
            @click="focusedRow = i"
          >
            <td
              v-for="col in columns"
              :key="col"
              class="px-4 py-2.5 text-neutral-700 align-top"
              :style="{ width: colWidth(col), maxWidth: colWidth(col) }"
            >
              <div class="max-h-24 overflow-y-auto whitespace-pre-wrap break-words" :title="cellText(row[col])">
                <a
                  v-if="documentHref(col, row[col])"
                  :href="documentHref(col, row[col])!"
                  class="text-sky-700 hover:text-sky-800 hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >{{ cellText(row[col]) }}</a>
                <template v-else>{{ cellText(row[col]) }}</template>
              </div>
            </td>
          </tr>
          <tr v-if="filtered.length === 0">
            <td :colspan="columns.length" class="px-4 py-4 text-center text-size-small text-neutral-400">No results</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div
      v-if="pageCount > 1"
      class="flex items-center justify-end gap-1 px-4 pt-3 text-size-small text-neutral-400"
    >
      <button
        class="px-2 py-0.5 rounded-sm border border-neutral-200 hover:bg-neutral-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        :disabled="page === 0"
        @click="page--"
      >←</button>
      <span>{{ page + 1 }} / {{ pageCount }}</span>
      <button
        class="px-2 py-0.5 rounded-sm border border-neutral-200 hover:bg-neutral-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        :disabled="page >= pageCount - 1"
        @click="page++"
      >→</button>
    </div>
  </div>
</template>
