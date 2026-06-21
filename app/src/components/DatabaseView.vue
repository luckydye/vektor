<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { plusIcon, tableColumnAddAfterIcon, trashSmallIcon } from "~/src/assets/icons.ts";
import type { DatabaseColumn } from "../composeables/useDatabaseRows.ts";
import { useDatabaseRows } from "../composeables/useDatabaseRows.ts";

const props = defineProps<{
  databaseDocumentId: string;
  spaceSlug: string;
  schemaJson?: string;
}>();

const {
  rows,
  derivedColumns,
  isLoading,
  setSchemaStr,
  addRow,
  updateRowProperty,
  deleteRow,
  addColumn,
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

// Add column dialog
const showAddColumn = ref(false);
const newColumnName = ref("");
const newColumnType = ref<DatabaseColumn["type"]>("text");
const newColumnInputRef = ref<HTMLInputElement | null>(null);

function openAddColumn() {
  showAddColumn.value = true;
  newColumnName.value = "";
  newColumnType.value = "text";
  nextTick(() => newColumnInputRef.value?.focus());
}

async function commitAddColumn() {
  const name = newColumnName.value.trim();
  if (!name) return;
  await addColumn({ name, type: newColumnType.value, label: name });
  showAddColumn.value = false;
}

function onAddColKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") commitAddColumn();
  if (e.key === "Escape") showAddColumn.value = false;
}

// Per-column delete confirmation
const deletingColumn = ref<string | null>(null);

async function confirmDeleteColumn(name: string) {
  await deleteColumn(name);
  deletingColumn.value = null;
}

// Row deletion
const deletingRow = ref<string | null>(null);

async function confirmDeleteRow(rowId: string) {
  await deleteRow(rowId);
  deletingRow.value = null;
}

function cellValue(row: Record<string, string>, col: string): string {
  return row[col] ?? "";
}

const DEFAULT_COL_WIDTH = 180;
const NAME_COL_WIDTH = 240;
</script>

<template>
  <div class="flex flex-col h-full min-h-0 overflow-hidden px-xs lg:px-xl">
    <!-- Toolbar -->
    <div class="flex items-center justify-between px-4 h-10 border-b border-neutral-100 bg-neutral-50 shrink-0">
      <span class="text-size-small text-neutral-500">{{ rows.length }} rows</span>
      <div class="flex items-center gap-2">
        <button
          class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-neutral-200 bg-background hover:bg-neutral-50 text-neutral-600 text-size-small transition-colors"
          @click="openAddColumn"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="tableColumnAddAfterIcon" />
          Add column
        </button>
        <button
          class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-neutral-200 bg-background hover:bg-neutral-50 text-neutral-600 text-size-small transition-colors"
          @click="addRow"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="plusIcon" />
          Add row
        </button>
      </div>
    </div>

    <!-- Add column dialog -->
    <div
      v-if="showAddColumn"
      class="absolute inset-0 z-50 flex items-center justify-center bg-black/20"
      @mousedown.self="showAddColumn = false"
    >
      <div class="bg-background rounded-xl border border-neutral-200 shadow-large p-5 w-72 flex flex-col gap-3">
        <div class="text-size-medium font-medium text-neutral-800">Add column</div>
        <div class="flex flex-col gap-1">
          <label class="text-size-small text-neutral-500">Name</label>
          <input
            ref="newColumnInputRef"
            v-model="newColumnName"
            type="text"
            placeholder="Column name"
            class="border border-neutral-200 rounded-lg px-3 py-1.5 text-size-medium bg-background focus:outline-none focus:border-primary-400"
            @keydown="onAddColKeydown"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-size-small text-neutral-500">Type</label>
          <select
            v-model="newColumnType"
            class="border border-neutral-200 rounded-lg px-3 py-1.5 text-size-medium bg-background focus:outline-none focus:border-primary-400"
          >
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
            <option value="select">Select</option>
          </select>
        </div>
        <div class="flex gap-2 justify-end">
          <button
            class="px-3 py-1.5 rounded border border-neutral-200 text-size-small hover:bg-neutral-50 transition-colors"
            @click="showAddColumn = false"
          >Cancel</button>
          <button
            class="px-3 py-1.5 rounded bg-primary-600 text-white text-size-small hover:bg-primary-700 transition-colors"
            @click="commitAddColumn"
          >Add</button>
        </div>
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
              class="group relative px-3 py-2 text-size-small font-medium text-neutral-500 uppercase tracking-wide border-b border-r border-neutral-100 whitespace-nowrap"
              :style="{ width: `${DEFAULT_COL_WIDTH}px` }"
            >
              <div class="flex items-center justify-between gap-1">
                <span class="truncate">{{ col.label }}</span>
                <button
                  class="opacity-0 group-hover:opacity-100 shrink-0 hover:text-red-500 transition-all"
                  title="Delete column"
                  @click="deletingColumn = col.name"
                >
                  <div class="svg-icon w-3.5 h-3.5" v-html="trashSmallIcon" />
                </button>
              </div>
              <!-- Delete column confirm -->
              <div
                v-if="deletingColumn === col.name"
                class="absolute top-full left-0 z-50 bg-background border border-neutral-200 rounded-lg shadow-large p-3 flex flex-col gap-2 w-44"
              >
                <div class="text-size-small text-neutral-700">Delete column "{{ col.label }}"?</div>
                <div class="flex gap-2">
                  <button class="text-size-small px-2 py-1 rounded border border-neutral-200 hover:bg-neutral-50 transition-colors" @click="deletingColumn = null">Cancel</button>
                  <button class="text-size-small px-2 py-1 rounded bg-red-500 text-white hover:bg-red-600 transition-colors" @click="confirmDeleteColumn(col.name)">Delete</button>
                </div>
              </div>
            </th>

            <!-- Actions column -->
            <th class="border-b border-neutral-100" :style="{ width: '48px' }" />
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
                  :href="`/${spaceSlug}/doc/${row.slug}`"
                  class="flex-1 truncate text-neutral-800 font-medium hover:text-primary-600 hover:underline transition-colors"
                >
                  {{ row.properties.title || "Untitled" }}
                </a>
                <button
                  class="opacity-0 group-hover:opacity-100 shrink-0 text-neutral-400 hover:text-neutral-700 transition-all"
                  title="Edit name"
                  @click="startEdit(row.id, 'title', row.properties.title || '')"
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
                class="opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-500 transition-all relative"
                title="Delete row"
                @click="deletingRow = row.id"
              >
                <div class="svg-icon w-3.5 h-3.5" v-html="trashSmallIcon" />
                <!-- Delete row confirm -->
                <div
                  v-if="deletingRow === row.id"
                  class="absolute top-full right-0 z-50 bg-background border border-neutral-200 rounded-lg shadow-large p-3 flex flex-col gap-2 w-44 text-left"
                  @click.stop
                >
                  <div class="text-size-small text-neutral-700">Delete this row?</div>
                  <div class="flex gap-2">
                    <button class="text-size-small px-2 py-1 rounded border border-neutral-200 hover:bg-neutral-50 transition-colors text-neutral-700" @click.stop="deletingRow = null">Cancel</button>
                    <button class="text-size-small px-2 py-1 rounded bg-red-500 text-white hover:bg-red-600 transition-colors" @click.stop="confirmDeleteRow(row.id)">Delete</button>
                  </div>
                </div>
              </button>
            </td>
          </tr>

          <!-- Empty state -->
          <tr v-if="rows.length === 0 && !isLoading">
            <td
              :colspan="derivedColumns.length + 2"
              class="px-4 py-8 text-center text-size-small text-neutral-400"
            >
              No rows yet. Click "Add row" to get started.
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Add row footer button -->
    <div class="border-t border-neutral-100 px-3 py-2 shrink-0">
      <button
        class="inline-flex items-center gap-1.5 text-size-small text-neutral-400 hover:text-neutral-700 transition-colors"
        @click="addRow"
      >
        <div class="svg-icon w-3.5 h-3.5" v-html="plusIcon" />
        New row
      </button>
    </div>
  </div>
</template>
