import "@atrium-ui/elements/popover";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import { useDatabaseFileImport } from "#composeables/useDatabaseFileImport.ts";
import type { DatabaseColumn } from "#composeables/useDatabaseRows.ts";
import { useDatabaseRows } from "#composeables/useDatabaseRows.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import {
  type DocumentProperties,
  propertyValueToText,
  readDocumentProperty,
} from "#documents/properties.ts";
import { spacePath } from "#utils/utils.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  databaseDocumentId: string;
  schemaJson?: string;
}

const DEFAULT_COL_WIDTH = 180;
const NAME_COL_WIDTH = 240;
const ACTION_COL_WIDTH = 48;

// Below this a full render costs less than the scroll bookkeeping around it.
const VIRTUALIZE_FROM_ROWS = 80;
const ROW_OVERSCAN = 8;
// Rows are single-line, so one measured height describes them all; this is the
// fallback until the first one is on screen.
const ESTIMATED_ROW_HEIGHT = 41;

function cellValue(row: DocumentProperties, col: string): string {
  // Column names come from the space's property keys, so a column called
  // `toString` would read `Object.prototype.toString` off the row and render the
  // function's source into the cell.
  const value = readDocumentProperty(row, col);
  return value ? propertyValueToText(value) : "";
}

function rowTitle(row: DocumentProperties): string {
  return cellValue(row, "title") || "Untitled";
}

export function DatabaseView(props: Props) {
  const { currentSpace } = useSpace();
  const { error: toastError } = useToast();

  const {
    rows,
    derivedColumns,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    setSchemaStr,
    addRow,
    refreshRows,
    updateRowProperty,
    deleteRow,
    addColumn,
    addColumns,
    deleteColumn,
  } = useDatabaseRows(() => props.databaseDocumentId);

  createEffect(() => setSchemaStr(props.schemaJson));

  const [editingCell, setEditingCell] = createSignal<{
    rowId: string;
    col: string;
  } | null>(null);
  const [editingValue, setEditingValue] = createSignal("");

  const focusEditInput = (el: HTMLInputElement) => {
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

  const [deletingRow, setDeletingRow] = createSignal<string | null>(null);
  const [rowPopoverStyle, setRowPopoverStyle] = createSignal<JSX.CSSProperties>({});

  createEffect(() => {
    void props.databaseDocumentId;
    setEditingCell(null);
    setDeletingColumn(null);
    setDeletingRow(null);
  });

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

  let importInputRef: HTMLInputElement | undefined;
  const { isImporting, importFile } = useDatabaseFileImport({
    derivedColumns,
    existingRows: rows,
    addColumns,
    addRow,
    refreshRows,
  });

  function openImportPicker() {
    if (isImporting()) return;
    importInputRef?.click();
  }

  async function onImportFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    await importFile(file);
  }

  const [hasMounted, setHasMounted] = createSignal(false);
  let bodyRef: HTMLTableSectionElement | undefined;
  // How far the body has scrolled past the top of the viewport, and how much
  // of the viewport it can occupy. Measured from the body's own rect rather
  // than a scroll container: depending on the layout the scroller is either the
  // table's wrapper or the page itself.
  const [bodyOffset, setBodyOffset] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [rowHeight, setRowHeight] = createSignal(ESTIMATED_ROW_HEIGHT);

  // Inline rather than `sticky top-0`: the app shell offsets every
  // `.sticky.top-0` by the titlebar height, which would push the header down
  // inside its own scroller.
  const stickyHeaderStyle = { position: "sticky", top: "0", "z-index": "1" } as const;

  const tableWidth = createMemo(
    () => NAME_COL_WIDTH + derivedColumns().length * DEFAULT_COL_WIDTH + ACTION_COL_WIDTH,
  );

  const isVirtualized = createMemo(
    () => hasMounted() && rows().length > VIRTUALIZE_FROM_ROWS,
  );

  const visibleRange = createMemo(() => {
    const total = rows().length;
    if (!isVirtualized()) return { start: 0, end: total };

    const height = rowHeight();
    const start = Math.max(0, Math.floor(bodyOffset() / height) - ROW_OVERSCAN);
    const visible = Math.ceil((viewportHeight() || height) / height);
    return { start, end: Math.min(total, start + visible + ROW_OVERSCAN * 2) };
  });

  const visibleRows = createMemo(() => {
    const { start, end } = visibleRange();
    return rows().slice(start, end);
  });

  // Spacer rows stand in for the ones outside the window, keeping the
  // scrollbar the size the full table would have.
  const spacerBefore = createMemo(() => visibleRange().start * rowHeight());
  const spacerAfter = createMemo(
    () => (rows().length - visibleRange().end) * rowHeight(),
  );

  function measureViewport() {
    setViewportHeight(window.innerHeight);
    if (!bodyRef) return;
    setBodyOffset(Math.max(0, -bodyRef.getBoundingClientRect().top));
  }

  onMount(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measureViewport();
      });
    };

    measureViewport();
    // Capture, so a scroll on whichever ancestor actually scrolls is seen.
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("resize", schedule, { passive: true });
    onCleanup(() => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    });
  });

  // The body only takes its place once the rows are painted, so measuring has
  // to wait a frame after they change.
  createEffect(() => {
    void rows().length;
    if (!hasMounted()) return;
    const frame = requestAnimationFrame(measureViewport);
    onCleanup(() => cancelAnimationFrame(frame));
  });

  // One real row is worth more than a guess: fonts and zoom both move it.
  createEffect(() => {
    if (!isVirtualized() || !visibleRows().length) return;
    const row = bodyRef?.querySelector<HTMLTableRowElement>("tr[data-row]");
    const measured = row?.getBoundingClientRect().height;
    if (measured && Math.abs(measured - rowHeight()) > 0.5) setRowHeight(measured);
  });

  onMount(() => setHasMounted(true));

  // Fetches the next page once the loaded rows are close to scrolled past —
  // the same "near the bottom" trigger Search.tsx uses, but against this
  // table's own scroll bookkeeping instead of window.scrollY, since the
  // scroller here is the table's ancestor, not necessarily the page.
  createEffect(() => {
    if (isFetchingNextPage() || !hasNextPage()) return;
    const totalHeight = rows().length * rowHeight();
    const scrolledToward = bodyOffset() + viewportHeight();
    if (scrolledToward >= totalHeight - 500) void fetchNextPage();
  });

  return (
    <>
      <div class="relative flex h-full min-h-0 flex-col overflow-hidden">
        <div class="flex h-10 shrink-0 items-center justify-between gap-3 rounded-t-md border border-neutral-100 border-b-0 bg-neutral-50 px-4">
          <span class="text-neutral-500 text-size-small">{rows().length} rows</span>
          <div class="flex items-center gap-1.5">
            <input
              ref={importInputRef}
              type="file"
              accept=".csv,text/csv,.ics,text/calendar"
              class="hidden"
              onChange={(event) => void onImportFileChange(event)}
            />
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded px-2 py-1 text-neutral-500 text-size-small transition-colors hover:bg-neutral-100 hover:text-neutral-800 disabled:pointer-events-none disabled:opacity-50"
              title="Import"
              disabled={isImporting()}
              onClick={openImportPicker}
            >
              <Icon class="h-3.5 w-3.5" name="csv-file" />
              Import
            </button>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-auto">
          <Show
            when={!isLoading()}
            fallback={
              <table
                class="border-separate border-spacing-0 animate-pulse overflow-hidden rounded-b-[var(--radius-md)] border border-neutral-100 [&_tbody_tr:last-child_>_td]:border-b-0 [&_td]:border-neutral-100 [&_td]:border-r [&_td]:border-b [&_th]:border-neutral-100 [&_th]:border-r [&_th]:border-b [&_tr_>_:last-child]:border-r-0"
                style={{ "table-layout": "fixed", width: "100%" }}
              >
                <thead>
                  <tr class="bg-neutral-50">
                    <th class="px-3 py-2.5" style={{ width: `${NAME_COL_WIDTH}px` }}>
                      <div class="h-2.5 w-16 rounded-full bg-neutral-200" />
                    </th>
                    <For each={[0, 1]}>
                      {() => (
                        <th
                          class="px-3 py-2.5"
                          style={{ width: `${DEFAULT_COL_WIDTH}px` }}
                        >
                          <div class="h-2.5 w-14 rounded-full bg-neutral-200" />
                        </th>
                      )}
                    </For>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <For each={[0.9, 0.6, 0.75]}>
                    {(width) => (
                      <tr>
                        <td class="px-3 py-2.5">
                          <div
                            class="h-2.5 rounded-full bg-neutral-100"
                            style={{ width: `${width * 100}%` }}
                          />
                        </td>
                        <For each={[0.5, 0.7]}>
                          {(cellWidth) => (
                            <td class="px-3 py-2.5">
                              <div
                                class="h-2.5 rounded-full bg-neutral-100"
                                style={{ width: `${cellWidth * 100}%` }}
                              />
                            </td>
                          )}
                        </For>
                        <td />
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            }
          >
            <table
              class="border-separate border-spacing-0 rounded-b-[var(--radius-md)] border border-neutral-100 text-size-medium [&_tbody_tr:last-child_>_td]:border-b-0 [&_td]:border-neutral-100 [&_td]:border-r [&_td]:border-b [&_td]:leading-[1.45] [&_th]:border-neutral-100 [&_th]:border-r [&_th]:border-b [&_th]:leading-[1.45] [&_tr_>_:last-child]:border-r-0"
              style={{
                "table-layout": "fixed",
                // An explicit sum, not `max-content`: that measured the cells,
                // so nowrap content widened its column instead of truncating,
                // and the width moved as rows scrolled in and out.
                width: `${tableWidth()}px`,
                "min-width": "100%",
              }}
            >
              <thead>
                <tr class="bg-neutral-50 text-left">
                  <th
                    class="relative whitespace-nowrap bg-neutral-50 px-3 py-2.5 font-semibold text-neutral-700 text-size-small"
                    style={{ ...stickyHeaderStyle, width: `${NAME_COL_WIDTH}px` }}
                  >
                    Name
                  </th>

                  <For each={derivedColumns()}>
                    {(col) => (
                      <th
                        class="group whitespace-nowrap bg-neutral-50 px-3 py-2.5 font-semibold text-neutral-700 text-size-small"
                        style={{ ...stickyHeaderStyle, width: `${DEFAULT_COL_WIDTH}px` }}
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

                  <th
                    class="bg-neutral-50 px-2"
                    style={{ ...stickyHeaderStyle, width: `${ACTION_COL_WIDTH}px` }}
                  >
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

              <tbody ref={bodyRef}>
                <Show when={spacerBefore() > 0}>
                  <tr>
                    <td
                      colspan={derivedColumns().length + 2}
                      class="border-0! p-0!"
                      style={{ height: `${spacerBefore()}px` }}
                    />
                  </tr>
                </Show>

                <For each={visibleRows()}>
                  {(row) => (
                    <tr class="group" data-row>
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

                      <td
                        class="px-2 py-2.5 align-top"
                        style={{ width: `${ACTION_COL_WIDTH}px` }}
                      >
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

                <Show when={spacerAfter() > 0}>
                  <tr>
                    <td
                      colspan={derivedColumns().length + 2}
                      class="border-0! p-0!"
                      style={{ height: `${spacerAfter()}px` }}
                    />
                  </tr>
                </Show>

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
