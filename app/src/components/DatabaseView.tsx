import "@atrium-ui/elements/popover";
import { createEffect, createSignal, For, type JSX, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { useDatabaseCsvImport } from "#composeables/useDatabaseCsvImport.ts";
import type { DatabaseColumn } from "#composeables/useDatabaseRows.ts";
import { useDatabaseRows } from "#composeables/useDatabaseRows.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import {
  type DocumentPropertyValue,
  propertyValueToText,
} from "#documents/properties.ts";
import { spacePath } from "#utils/utils.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  databaseDocumentId: string;
  schemaJson?: string;
}

const DEFAULT_COL_WIDTH = 180;
const NAME_COL_WIDTH = 240;

function cellValue(row: Record<string, DocumentPropertyValue>, col: string): string {
  const value = row[col];
  return value ? propertyValueToText(value) : "";
}

function rowTitle(row: Record<string, DocumentPropertyValue>): string {
  return cellValue(row, "title") || "Untitled";
}

export function DatabaseView(props: Props) {
  const { currentSpace } = useSpace();
  const { error: toastError } = useToast();

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

  createEffect(() => setSchemaStr(props.schemaJson));

  // Inline cell editing state
  const [editingCell, setEditingCell] = createSignal<{
    rowId: string;
    col: string;
  } | null>(null);
  const [editingValue, setEditingValue] = createSignal("");

  /** Focuses the freshly-rendered edit input. Only one cell edits at a time. */
  const focusEditInput = (el: HTMLInputElement) => {
    // The element is in the document by the time a ref callback runs, but not
    // yet painted; a frame later it can take focus.
    requestAnimationFrame(() => el.focus());
  };

  function startEdit(rowId: string, col: string, currentValue: string) {
    setEditingCell({ rowId, col });
    setEditingValue(currentValue);
  }

  async function commitEdit() {
    const cell = editingCell();
    if (!cell) return;
    await updateRowProperty(cell.rowId, cell.col, editingValue());
    setEditingCell(null);
  }

  function cancelEdit() {
    setEditingCell(null);
  }

  function onCellKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") void commitEdit();
    if (e.key === "Escape") cancelEdit();
  }

  // Add column popover
  const [newColumnName, setNewColumnName] = createSignal("");
  const [newColumnType, setNewColumnType] = createSignal<DatabaseColumn["type"]>("text");
  let newColumnInputRef: HTMLInputElement | undefined;
  let addColumnTriggerRef: (HTMLElement & { hide?: () => void }) | undefined;

  function onAddColumnTrigger() {
    setNewColumnName("");
    setNewColumnType("text");
    requestAnimationFrame(() => newColumnInputRef?.focus());
  }

  async function commitAddColumn() {
    const name = newColumnName().trim();
    if (!name) return;
    await addColumn({ name, type: newColumnType(), label: name });
    addColumnTriggerRef?.hide?.();
  }

  function onAddColKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") void commitAddColumn();
    if (e.key === "Escape") addColumnTriggerRef?.hide?.();
  }

  // Per-column delete confirmation
  const [deletingColumn, setDeletingColumn] = createSignal<string | null>(null);
  const [columnPopoverStyle, setColumnPopoverStyle] = createSignal<JSX.CSSProperties>({});

  function openDeleteColumn(name: string, event: MouseEvent) {
    setDeletingColumn(name);
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setColumnPopoverStyle({ top: `${rect.bottom + 4}px`, left: `${rect.left}px` });
  }

  async function confirmDeleteColumn(name: string) {
    await deleteColumn(name);
    setDeletingColumn(null);
  }

  // Row deletion
  const [deletingRow, setDeletingRow] = createSignal<string | null>(null);
  const [rowPopoverStyle, setRowPopoverStyle] = createSignal<JSX.CSSProperties>({});

  function openDeleteRow(rowId: string, event: MouseEvent) {
    setDeletingRow(rowId);
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setRowPopoverStyle({
      top: `${rect.bottom + 4}px`,
      right: `${window.innerWidth - rect.right}px`,
    });
  }

  async function confirmDeleteRow(rowId: string) {
    try {
      await deleteRow(rowId);
      setDeletingRow(null);
    } catch (e) {
      setDeletingRow(null);
      toastError(e instanceof Error ? e.message : "Failed to delete row");
    }
  }

  // CSV import
  let csvInputRef: HTMLInputElement | undefined;
  const { isImportingCsv, importCsvFile } = useDatabaseCsvImport({
    derivedColumns,
    addColumns,
    addRow,
    refreshRows,
  });

  function openCsvPicker() {
    if (isImportingCsv()) return;
    csvInputRef?.click();
  }

  async function onCsvFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    await importCsvFile(file);
  }

  // The confirm popovers portal into <body>, which does not exist during SSR.
  const [hasMounted, setHasMounted] = createSignal(false);
  onMount(() => setHasMounted(true));

  return (
    <>
      <div class="relative flex h-full min-h-0 flex-col overflow-hidden px-xs lg:px-m">
        {/* Toolbar */}
        <div class="flex h-10 shrink-0 items-center justify-between gap-3 rounded-t-md border border-neutral-100 border-b-0 bg-neutral-50 px-4">
          <span class="text-neutral-500 text-size-small">{rows().length} rows</span>
          <div class="flex items-center gap-1.5">
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv,text/csv"
              class="hidden"
              onChange={(event) => void onCsvFileChange(event)}
            />
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded px-2 py-1 text-neutral-500 text-size-small transition-colors hover:bg-neutral-100 hover:text-neutral-800 disabled:pointer-events-none disabled:opacity-50"
              title="Import CSV"
              disabled={isImportingCsv()}
              onClick={openCsvPicker}
            >
              <Icon class="h-3.5 w-3.5" name="csv-file" />
              Import CSV
            </button>
          </div>
        </div>

        {/* Table */}
        <div class="min-h-0 flex-1 overflow-auto">
          <Show
            when={!isLoading()}
            fallback={
              <div class="flex h-24 items-center justify-center text-neutral-400 text-size-small">
                Loading…
              </div>
            }
          >
            <table
              class="border-separate border-spacing-0 overflow-hidden rounded-b-[var(--radius-md)] border border-neutral-100 text-size-medium [&_tbody_tr:last-child_>_td]:border-b-0 [&_td]:border-neutral-100 [&_td]:border-r [&_td]:border-b [&_td]:leading-[1.45] [&_th]:border-neutral-100 [&_th]:border-r [&_th]:border-b [&_th]:leading-[1.45] [&_tr_>_:last-child]:border-r-0"
              style={{
                "table-layout": "fixed",
                width: "max-content",
                "min-width": "100%",
              }}
            >
              <thead>
                <tr class="bg-neutral-50 text-left">
                  {/* Name column header */}
                  <th
                    class="relative whitespace-nowrap px-3 py-2.5 font-semibold text-neutral-700 text-size-small"
                    style={{ width: `${NAME_COL_WIDTH}px` }}
                  >
                    Name
                  </th>

                  {/* Property column headers */}
                  <For each={derivedColumns()}>
                    {(col) => (
                      <th
                        class="group whitespace-nowrap px-3 py-2.5 font-semibold text-neutral-700 text-size-small"
                        style={{ width: `${DEFAULT_COL_WIDTH}px` }}
                      >
                        <div class="flex items-center justify-between gap-1">
                          <span class="truncate">{col.label}</span>
                          <button
                            type="button"
                            class="shrink-0 opacity-0 transition-all hover:text-red-500 group-hover:opacity-100"
                            title="Delete column"
                            onClick={(event) => openDeleteColumn(col.name, event)}
                          >
                            <Icon class="h-3.5 w-3.5" name="delete-entry" />
                          </button>
                        </div>
                      </th>
                    )}
                  </For>

                  {/* Add column button */}
                  <th class="px-2" style={{ width: "48px" }}>
                    <a-popover-trigger ref={addColumnTriggerRef as never}>
                      <button
                        type="button"
                        slot="trigger"
                        class="flex h-6 w-6 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
                        title="Add column"
                        onClick={onAddColumnTrigger}
                      >
                        <Icon class="h-3.5 w-3.5" name="add" />
                      </button>
                      <a-popover class="group" placements="bottom-end">
                        <div class="w-max opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
                          <div class="mt-1 flex w-56 flex-col gap-3 rounded-xl border border-neutral-200 bg-background p-4 shadow-large">
                            <div class="font-medium text-neutral-700 text-size-small">
                              Add column
                            </div>
                            <input
                              ref={newColumnInputRef}
                              value={newColumnName()}
                              onInput={(e) => setNewColumnName(e.currentTarget.value)}
                              type="text"
                              placeholder="Column name"
                              class="rounded-lg border border-neutral-200 bg-background px-3 py-1.5 text-size-medium focus:border-primary-400 focus:outline-none"
                              onKeyDown={onAddColKeydown}
                            />
                            <select
                              value={newColumnType()}
                              onChange={(e) =>
                                setNewColumnType(
                                  e.currentTarget.value as DatabaseColumn["type"],
                                )
                              }
                              class="rounded-lg border border-neutral-200 bg-background px-3 py-1.5 text-size-medium focus:border-primary-400 focus:outline-none"
                            >
                              <option value="text">Text</option>
                              <option value="number">Number</option>
                              <option value="date">Date</option>
                              <option value="select">Select</option>
                            </select>
                            <button
                              type="button"
                              class="rounded bg-primary-600 px-3 py-1.5 text-size-small text-white transition-colors hover:bg-primary-700"
                              onClick={() => void commitAddColumn()}
                            >
                              Add
                            </button>
                          </div>
                        </div>
                      </a-popover>
                    </a-popover-trigger>
                  </th>
                </tr>
              </thead>

              <tbody>
                <For each={rows()}>
                  {(row) => (
                    <tr class="group">
                      {/* Name cell — links to document */}
                      <td
                        class="px-3 py-2.5 align-top"
                        style={{ width: `${NAME_COL_WIDTH}px` }}
                      >
                        <Show
                          when={
                            editingCell()?.rowId === row.id &&
                            editingCell()?.col === "title"
                          }
                          fallback={
                            <div class="flex min-w-0 items-center gap-2">
                              <a
                                href={spacePath(currentSpace()?.slug, `/doc/${row.slug}`)}
                                class="flex-1 truncate font-medium text-neutral-800 transition-colors hover:text-primary-600 hover:underline"
                              >
                                {rowTitle(row.properties)}
                              </a>
                              <button
                                type="button"
                                class="shrink-0 text-neutral-400 opacity-0 transition-all hover:text-neutral-700 group-hover:opacity-100"
                                title="Edit name"
                                onClick={() =>
                                  startEdit(row.id, "title", rowTitle(row.properties))
                                }
                              >
                                <Icon class="h-3.5 w-3.5" name="edit-entry" />
                              </button>
                            </div>
                          }
                        >
                          <div class="flex items-center">
                            <input
                              ref={focusEditInput}
                              value={editingValue()}
                              onInput={(e) => setEditingValue(e.currentTarget.value)}
                              class="flex-1 border-none bg-transparent text-neutral-800 text-size-medium outline-none"
                              onBlur={() => void commitEdit()}
                              onKeyDown={onCellKeydown}
                            />
                          </div>
                        </Show>
                      </td>

                      {/* Property cells */}
                      <For each={derivedColumns()}>
                        {(col) => (
                          // biome-ignore lint/a11y/noStaticElementInteractions: the cell is the edit affordance; the input it opens is the control.
                          // biome-ignore lint/a11y/useKeyWithClickEvents: the row link and the edit button are the keyboard paths.
                          <td
                            class="px-3 py-2.5 align-top"
                            style={{ width: `${DEFAULT_COL_WIDTH}px` }}
                            onClick={() =>
                              startEdit(
                                row.id,
                                col.name,
                                cellValue(row.properties, col.name),
                              )
                            }
                          >
                            <Show
                              when={
                                editingCell()?.rowId === row.id &&
                                editingCell()?.col === col.name
                              }
                              fallback={
                                <div
                                  class="min-h-[1.25rem] cursor-text truncate text-neutral-700"
                                  classList={{
                                    "text-neutral-300 italic": !cellValue(
                                      row.properties,
                                      col.name,
                                    ),
                                  }}
                                >
                                  {cellValue(row.properties, col.name) || "—"}
                                </div>
                              }
                            >
                              {/* biome-ignore lint/a11y/noStaticElementInteractions: stops the cell's own click from restarting the edit it opened. */}
                              {/* biome-ignore lint/a11y/useKeyWithClickEvents: nothing is activated here, so there is no keyboard equivalent to add. */}
                              <div
                                class="flex items-center"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <input
                                  ref={focusEditInput}
                                  value={editingValue()}
                                  onInput={(e) => setEditingValue(e.currentTarget.value)}
                                  type={
                                    col.type === "number"
                                      ? "number"
                                      : col.type === "date"
                                        ? "date"
                                        : "text"
                                  }
                                  class="w-full border-none bg-transparent text-neutral-700 text-size-medium outline-none"
                                  onBlur={() => void commitEdit()}
                                  onKeyDown={onCellKeydown}
                                />
                              </div>
                            </Show>
                          </td>
                        )}
                      </For>

                      {/* Row actions */}
                      <td class="px-2 py-2.5 align-top" style={{ width: "48px" }}>
                        <button
                          type="button"
                          class="text-neutral-400 opacity-0 transition-all hover:text-red-500 group-hover:opacity-100"
                          title="Delete row"
                          onClick={(event) => openDeleteRow(row.id, event)}
                        >
                          <Icon class="h-3.5 w-3.5" name="delete-entry" />
                        </button>
                      </td>
                    </tr>
                  )}
                </For>

                {/* Empty state */}
                <Show when={rows().length === 0 && !isLoading()}>
                  <tr>
                    <td
                      colspan={derivedColumns().length + 2}
                      class="px-4 py-8 text-center text-neutral-400 text-size-small"
                    >
                      No rows yet. Click "New row" or import a CSV to get started.
                    </td>
                  </tr>
                </Show>
              </tbody>
            </table>
          </Show>
        </div>

        {/* Add row footer button */}
        <div class="shrink-0 border-neutral-100 border-t px-3 py-2">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 text-neutral-400 text-size-small transition-colors hover:text-neutral-700"
            onClick={() => void addRow()}
          >
            <Icon class="h-3.5 w-3.5" name="add" />
            New row
          </button>
        </div>
      </div>

      <Show when={hasMounted()}>
        <Portal>
          {/* Delete column popover */}
          <Show when={deletingColumn()}>
            {(name) => (
              // biome-ignore lint/a11y/noStaticElementInteractions: a click-away backdrop; the Cancel button is the keyboard path.
              <div
                class="fixed inset-0 z-50"
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget) setDeletingColumn(null);
                }}
              >
                <div
                  class="absolute flex w-44 flex-col gap-2 rounded-lg border border-neutral-200 bg-background p-3 shadow-large"
                  style={columnPopoverStyle()}
                >
                  <div class="text-neutral-700 text-size-small">
                    Delete column "
                    {derivedColumns().find((c) => c.name === name())?.label}"?
                  </div>
                  <div class="flex gap-2">
                    <button
                      type="button"
                      class="rounded border border-neutral-200 px-2 py-1 text-size-small transition-colors hover:bg-neutral-50"
                      onClick={() => setDeletingColumn(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      class="rounded bg-red-500 px-2 py-1 text-size-small text-white transition-colors hover:bg-red-600"
                      onClick={() => void confirmDeleteColumn(name())}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            )}
          </Show>

          {/* Delete row popover */}
          <Show when={deletingRow()}>
            {(rowId) => (
              // biome-ignore lint/a11y/noStaticElementInteractions: a click-away backdrop; the Cancel button is the keyboard path.
              <div
                class="fixed inset-0 z-50"
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget) setDeletingRow(null);
                }}
              >
                <div
                  class="absolute flex w-44 flex-col gap-2 rounded-lg border border-neutral-200 bg-background p-3 shadow-large"
                  style={rowPopoverStyle()}
                >
                  <div class="text-neutral-700 text-size-small">Delete this row?</div>
                  <div class="flex gap-2">
                    <button
                      type="button"
                      class="rounded border border-neutral-200 px-2 py-1 text-neutral-700 text-size-small transition-colors hover:bg-neutral-50"
                      onClick={() => setDeletingRow(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      class="rounded bg-red-500 px-2 py-1 text-size-small text-white transition-colors hover:bg-red-600"
                      onClick={() => void confirmDeleteRow(rowId())}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            )}
          </Show>
        </Portal>
      </Show>
    </>
  );
}
