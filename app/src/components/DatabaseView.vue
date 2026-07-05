<script setup lang="ts">
import "@atrium-ui/elements/popover";
import { nextTick, ref, watch } from "vue";
import { fileSpreadsheetIcon, plusIcon, trashSmallIcon } from "~/src/assets/icons.ts";
import { useDatabaseCsvImport } from "#composeables/useDatabaseCsvImport.ts";
import type { DatabaseColumn } from "#composeables/useDatabaseRows.ts";
import { useDatabaseRows } from "#composeables/useDatabaseRows.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import {
  type DocumentPropertyValue,
  propertyValueToText,
} from "#utils/documentProperties.ts";
import { spacePath } from "#utils/utils.ts";

const { currentSpace } = useSpace();

const { error: toastError } = useToast();

const props = defineProps<{
  databaseDocumentId: string;
  schemaJson?: string;
}>();

const {
  rows,
  derivedColumns,
  isLoading,
  setSchemaStr,
  addRow,
  refreshRows,
  updateRowProperty,
  deleteRow,
  addColumn,
  addColumns,
  deleteColumn,
} = useDatabaseRows(props.databaseDocumentId);

watch(
  () => props.schemaJson,
  (val) => setSchemaStr(val),
  { immediate: true },
);

// Inline cell editing state
const editingCell = ref<{ rowId: string; col: string } | null>(null);
const editingValue = ref("");
const editInputRef = ref<HTMLInputElement | null>(null);

function startEdit(rowId: string, col: string, currentValue: string) {
  editingCell.value = { rowId, col };
  editingValue.value = currentValue;
  nextTick(() => editInputRef.value?.focus());
}

async function commitEdit() {
  if (!editingCell.value) return;
  const { rowId, col } = editingCell.value;
  await updateRowProperty(rowId, col, editingValue.value);
  editingCell.value = null;
}

function cancelEdit() {
  editingCell.value = null;
}

function onCellKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") commitEdit();
  if (e.key === "Escape") cancelEdit();
}

// Add column popover
const newColumnName = ref("");
const newColumnType = ref<DatabaseColumn["type"]>("text");
const newColumnInputRef = ref<HTMLInputElement | null>(null);
const addColumnTriggerRef = ref<(HTMLElement & { hide?: () => void }) | null>(null);

function onAddColumnTrigger() {
  newColumnName.value = "";
  newColumnType.value = "text";
  nextTick(() => newColumnInputRef.value?.focus());
}

async function commitAddColumn() {
  const name = newColumnName.value.trim();
  if (!name) return;
  await addColumn({ name, type: newColumnType.value, label: name });
  addColumnTriggerRef.value?.hide?.();
}

function onAddColKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") commitAddColumn();
  if (e.key === "Escape") addColumnTriggerRef.value?.hide?.();
}

// Per-column delete confirmation
const deletingColumn = ref<string | null>(null);
const columnPopoverStyle = ref<Record<string, string>>({});

function openDeleteColumn(name: string, event: MouseEvent) {
  deletingColumn.value = name;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  columnPopoverStyle.value = { top: `${rect.bottom + 4}px`, left: `${rect.left}px` };
}

async function confirmDeleteColumn(name: string) {
  await deleteColumn(name);
  deletingColumn.value = null;
}

// Row deletion
const deletingRow = ref<string | null>(null);
const rowPopoverStyle = ref<Record<string, string>>({});

function openDeleteRow(rowId: string, event: MouseEvent) {
  deletingRow.value = rowId;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  rowPopoverStyle.value = {
    top: `${rect.bottom + 4}px`,
    right: `${window.innerWidth - rect.right}px`,
  };
}

async function confirmDeleteRow(rowId: string) {
  try {
    await deleteRow(rowId);
    deletingRow.value = null;
  } catch (e) {
    deletingRow.value = null;
    toastError(e instanceof Error ? e.message : "Failed to delete row");
  }
}

function cellValue(row: Record<string, DocumentPropertyValue>, col: string): string {
  const value = row[col];
  return value ? propertyValueToText(value) : "";
}

function rowTitle(row: Record<string, DocumentPropertyValue>): string {
  return cellValue(row, "title") || "Untitled";
}

const DEFAULT_COL_WIDTH = 180;
const NAME_COL_WIDTH = 240;

// CSV import
const csvInputRef = ref<HTMLInputElement | null>(null);
const { isImportingCsv, importCsvFile } = useDatabaseCsvImport({
  derivedColumns,
  addColumns,
  addRow,
  refreshRows,
});

function openCsvPicker() {
  if (isImportingCsv.value) return;
  csvInputRef.value?.click();
}

async function onCsvFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  await importCsvFile(file);
}
</script>

<template>
  <div class="relative flex flex-col h-full min-h-0 overflow-hidden px-xs lg:px-xl">
    <!-- Toolbar -->
    <div class="flex items-center justify-between gap-3 px-4 h-10 border-b border-neutral-100 bg-neutral-50 shrink-0">
      <span class="text-size-small text-neutral-500">{{ rows.length }} rows</span>
      <div class="flex items-center gap-1.5">
        <input
          ref="csvInputRef"
          type="file"
          accept=".csv,text/csv"
          class="hidden"
          @change="onCsvFileChange"
        />
        <button
          class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-size-small text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100 disabled:opacity-50 disabled:pointer-events-none transition-colors"
          title="Import CSV"
          :disabled="isImportingCsv"
          @click="openCsvPicker"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="fileSpreadsheetIcon" />
          Import CSV
        </button>
      </div>
    </div>

    <!-- Table -->
    <div class="overflow-auto flex-1 min-h-0">
      <div v-if="isLoading" class="flex items-center justify-center h-24 text-neutral-400 text-size-small">
        Loading…
      </div>

      <table
        v-else
        class="text-size-medium border-collapse"
        style="table-layout: fixed; width: max-content; min-width: 100%;"
      >
        <thead>
          <tr class="bg-neutral-50 text-left">
            <!-- Name column header -->
            <th
              class="relative px-3 py-2 text-size-small font-medium text-neutral-500 uppercase tracking-wide border-b border-r border-neutral-100 whitespace-nowrap"
              :style="{ width: `${NAME_COL_WIDTH}px` }"
            >
              Name
            </th>

            <!-- Property column headers -->
            <th
              v-for="col in derivedColumns"
              :key="col.name"
              class="group px-3 py-2 text-size-small font-medium text-neutral-500 uppercase tracking-wide border-b border-r border-neutral-100 whitespace-nowrap"
              :style="{ width: `${DEFAULT_COL_WIDTH}px` }"
            >
              <div class="flex items-center justify-between gap-1">
                <span class="truncate">{{ col.label }}</span>
                <button
                  class="opacity-0 group-hover:opacity-100 shrink-0 hover:text-red-500 transition-all"
                  title="Delete column"
                  @click="openDeleteColumn(col.name, $event)"
                >
                  <div class="svg-icon w-3.5 h-3.5" v-html="trashSmallIcon" />
                </button>
              </div>
            </th>

            <!-- Add column button -->
            <th class="border-b border-neutral-100 px-2" :style="{ width: '48px' }">
              <a-popover-trigger ref="addColumnTriggerRef">
                <button
                  slot="trigger"
                  class="flex items-center justify-center w-6 h-6 rounded text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 transition-colors"
                  title="Add column"
                  @click="onAddColumnTrigger"
                >
                  <div class="svg-icon w-3.5 h-3.5" v-html="plusIcon" />
                </button>
                <a-popover class="group" placements="bottom-end">
                  <div class="w-max opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
                    <div class="bg-background border border-neutral-200 rounded-xl shadow-large p-4 w-56 flex flex-col gap-3 mt-1">
                      <div class="text-size-small font-medium text-neutral-700">Add column</div>
                      <input
                        ref="newColumnInputRef"
                        v-model="newColumnName"
                        type="text"
                        placeholder="Column name"
                        class="border border-neutral-200 rounded-lg px-3 py-1.5 text-size-medium bg-background focus:outline-none focus:border-primary-400"
                        @keydown="onAddColKeydown"
                      />
                      <select
                        v-model="newColumnType"
                        class="border border-neutral-200 rounded-lg px-3 py-1.5 text-size-medium bg-background focus:outline-none focus:border-primary-400"
                      >
                        <option value="text">Text</option>
                        <option value="number">Number</option>
                        <option value="date">Date</option>
                        <option value="select">Select</option>
                      </select>
                      <button
                        class="px-3 py-1.5 rounded bg-primary-600 text-white text-size-small hover:bg-primary-700 transition-colors"
                        @click="commitAddColumn"
                      >Add</button>
                    </div>
                  </div>
                </a-popover>
              </a-popover-trigger>
            </th>
          </tr>
        </thead>

        <tbody>
          <tr
            v-for="row in rows"
            :key="row.id"
            class="border-b border-neutral-100 hover:bg-neutral-50 transition-colors group"
          >
            <!-- Name cell — links to document -->
            <td
              class="px-3 py-2 border-r border-neutral-100 align-top"
              :style="{ width: `${NAME_COL_WIDTH}px` }"
            >
              <div
                v-if="editingCell?.rowId === row.id && editingCell?.col === 'title'"
                class="flex items-center"
              >
                <input
                  ref="editInputRef"
                  v-model="editingValue"
                  class="flex-1 bg-transparent border-none outline-none text-size-medium text-neutral-800"
                  @blur="commitEdit"
                  @keydown="onCellKeydown"
                />
              </div>
              <div v-else class="flex items-center gap-2 min-w-0">
                <a
                  :href="spacePath(currentSpace?.slug, `/doc/${row.slug}`)"
                  class="flex-1 truncate text-neutral-800 font-medium hover:text-primary-600 hover:underline transition-colors"
                >
                  {{ rowTitle(row.properties) }}
                </a>
                <button
                  class="opacity-0 group-hover:opacity-100 shrink-0 text-neutral-400 hover:text-neutral-700 transition-all"
                  title="Edit name"
                  @click="startEdit(row.id, 'title', rowTitle(row.properties))"
                >
                  <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z" />
                  </svg>
                </button>
              </div>
            </td>

            <!-- Property cells -->
            <td
              v-for="col in derivedColumns"
              :key="col.name"
              class="px-3 py-2 border-r border-neutral-100 align-top"
              :style="{ width: `${DEFAULT_COL_WIDTH}px` }"
              @click="startEdit(row.id, col.name, cellValue(row.properties, col.name))"
            >
              <div
                v-if="editingCell?.rowId === row.id && editingCell?.col === col.name"
                class="flex items-center"
                @click.stop
              >
                <input
                  ref="editInputRef"
                  v-model="editingValue"
                  :type="col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : 'text'"
                  class="w-full bg-transparent border-none outline-none text-size-medium text-neutral-700"
                  @blur="commitEdit"
                  @keydown="onCellKeydown"
                />
              </div>
              <div
                v-else
                class="truncate text-neutral-700 cursor-text min-h-[1.25rem]"
                :class="{ 'text-neutral-300 italic': !cellValue(row.properties, col.name) }"
              >
                {{ cellValue(row.properties, col.name) || "—" }}
              </div>
            </td>

            <!-- Row actions -->
            <td class="px-2 py-2 align-top" :style="{ width: '48px' }">
              <button
                class="opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-500 transition-all"
                title="Delete row"
                @click="openDeleteRow(row.id, $event)"
              >
                <div class="svg-icon w-3.5 h-3.5" v-html="trashSmallIcon" />
              </button>
            </td>
          </tr>

          <!-- Empty state -->
          <tr v-if="rows.length === 0 && !isLoading">
            <td
              :colspan="derivedColumns.length + 2"
              class="px-4 py-8 text-center text-size-small text-neutral-400"
            >
              No rows yet. Click "New row" or import a CSV to get started.
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Add row footer button -->
    <div class="border-t border-neutral-100 px-3 py-2 shrink-0">
      <button
        class="inline-flex items-center gap-1.5 text-size-small text-neutral-400 hover:text-neutral-700 transition-colors"
        @click="() => addRow()"
      >
        <div class="svg-icon w-3.5 h-3.5" v-html="plusIcon" />
        New row
      </button>
    </div>
  </div>

  <!-- Delete column popover -->
  <Teleport to="body">
    <div
      v-if="deletingColumn"
      class="fixed inset-0 z-50"
      @mousedown.self="deletingColumn = null"
    >
      <div
        class="absolute bg-background border border-neutral-200 rounded-lg shadow-large p-3 flex flex-col gap-2 w-44"
        :style="columnPopoverStyle"
      >
        <div class="text-size-small text-neutral-700">Delete column "{{ derivedColumns.find(c => c.name === deletingColumn)?.label }}"?</div>
        <div class="flex gap-2">
          <button class="text-size-small px-2 py-1 rounded border border-neutral-200 hover:bg-neutral-50 transition-colors" @click="deletingColumn = null">Cancel</button>
          <button class="text-size-small px-2 py-1 rounded bg-red-500 text-white hover:bg-red-600 transition-colors" @click="confirmDeleteColumn(deletingColumn!)">Delete</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- Delete row popover -->
  <Teleport to="body">
    <div
      v-if="deletingRow"
      class="fixed inset-0 z-50"
      @mousedown.self="deletingRow = null"
    >
      <div
        class="absolute bg-background border border-neutral-200 rounded-lg shadow-large p-3 flex flex-col gap-2 w-44"
        :style="rowPopoverStyle"
      >
        <div class="text-size-small text-neutral-700">Delete this row?</div>
        <div class="flex gap-2">
          <button class="text-size-small px-2 py-1 rounded border border-neutral-200 hover:bg-neutral-50 transition-colors text-neutral-700" @click="deletingRow = null">Cancel</button>
          <button class="text-size-small px-2 py-1 rounded bg-red-500 text-white hover:bg-red-600 transition-colors" @click="confirmDeleteRow(deletingRow!)">Delete</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
