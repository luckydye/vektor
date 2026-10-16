import "@atrium-ui/elements/popover";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { twMerge } from "tailwind-merge";
import { useColumnWidths } from "#composeables/useColumnWidths.ts";
import { useDatabaseFileImport } from "#composeables/useDatabaseFileImport.ts";
import type { DatabaseColumn, DatabaseSort } from "#composeables/useDatabaseRows.ts";
import { useDatabaseRows } from "#composeables/useDatabaseRows.ts";
import { confirmDialog } from "#composeables/useDialogs.ts";
import { useDocuments } from "#composeables/useDocuments.ts";
import { usePersistedState } from "#composeables/usePersistedState.ts";
import { useSelection } from "#composeables/useSelection.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import { useLocale } from "#composeables/useTranslation.ts";
import {
  type DocumentProperties,
  propertyValueToText,
  readDocumentProperty,
} from "#documents/properties.ts";
import { documentOption } from "#documents/title.ts";
import { spacePath } from "#utils/utils.ts";
import { ContextMenu, ContextMenuSeparator } from "./ContextMenu.tsx";
import { ContextMenuItem } from "./ContextMenuItem.tsx";
import { Icon } from "./Icon.tsx";
import { PropertyChip } from "./PropertyChip.tsx";

interface Props {
  databaseDocumentId: string;
  schemaJson?: string;
}

const COLUMN_TYPES: { type: DatabaseColumn["type"]; label: string }[] = [
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "date", label: "Date" },
  { type: "select", label: "Select" },
  { type: "document", label: "Document" },
];

const DEFAULT_COL_WIDTH = 180;
const NAME_COL_WIDTH = 240;
const ACTION_COL_WIDTH = 48;
const SELECT_COL_WIDTH = 36;

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

// Only absolute http(s) values become links; anything else stays plain text.
function cellHref(value: string): string | undefined {
  const url = URL.parse(value.trim());
  return url?.protocol === "http:" || url?.protocol === "https:" ? url.href : undefined;
}

function rowTitle(row: DocumentProperties): string {
  return cellValue(row, "title") || "Untitled";
}

export function DatabaseView(props: Props) {
  const { value: sort, commit: commitSort } = usePersistedState<DatabaseSort | null>({
    key: () => `database-sort:${props.databaseDocumentId}`,
    fallback: null,
  });
  const ariaSort = (key: string) =>
    sort()?.key === key
      ? sort()?.order === "asc"
        ? "ascending"
        : "descending"
      : undefined;

  // Before any state change: an item that unmounts with it can no longer
  // reach the menu with its exit event.
  function closeMenu(event: Event) {
    (event.currentTarget as Element).dispatchEvent(
      new CustomEvent("exit", { bubbles: true }),
    );
  }

  // Clicking a header cycles ascending → descending → unsorted.
  function cycleSort(key: string) {
    const current = sort();
    if (current?.key !== key) commitSort({ key, order: "asc" });
    else if (current.order === "asc") commitSort({ key, order: "desc" });
    else commitSort(null);
  }

  // Column actions sit behind the dots, so the header itself stays a plain
  // sort toggle; the cell keeps its highlight while the menu is open.
  // Accessors, so a type change updates the header in place instead of
  // remounting it under its open menu. `type` is unset for the name column.
  const columnHeader = (
    key: string,
    label: () => string,
    type: () => DatabaseColumn["type"] | undefined,
  ) => (
    <div class="flex w-full items-center transition-colors has-[[aria-expanded=true]]:bg-neutral-100 has-[input]:bg-neutral-100">
      <Show
        when={renamingColumn() === key}
        fallback={
          <button
            type="button"
            class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-2.5 pl-3 text-left transition-colors hover:text-neutral-950"
            onClick={() => cycleSort(key)}
          >
            <span class="truncate">{label()}</span>
            <Show when={sort()?.key === key}>
              <Icon
                name="arrow-left"
                class={twMerge(
                  "h-3.5 w-3.5 shrink-0 text-primary-600",
                  sort()?.order === "asc" ? "rotate-90" : "-rotate-90",
                )}
              />
            </Show>
          </button>
        }
      >
        <input
          ref={(el) =>
            requestAnimationFrame(() => {
              el.focus();
              el.select();
            })
          }
          value={label()}
          aria-label="Column name"
          class="min-w-0 flex-1 bg-transparent py-2.5 pl-3 font-semibold text-neutral-950 outline-none"
          onKeyDown={(event) => {
            if (event.key === "Enter") void commitRename(key, event.currentTarget.value);
            if (event.key === "Escape") setRenamingColumn(null);
          }}
          onBlur={(event) => void commitRename(key, event.currentTarget.value)}
        />
      </Show>
      <Show when={type()} fallback={<span class="pr-3" />}>
        <ContextMenu
          placements="bottom-end"
          ariaLabel={`${label()} column`}
          trigger={
            <button
              type="button"
              slot="trigger"
              aria-label={`${label()} column actions`}
              onClick={() => setTypeMenuColumn(null)}
              class="mr-1.5 ml-1 flex cursor-pointer rounded p-1 text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-700 aria-expanded:bg-neutral-200 aria-expanded:text-neutral-700"
            >
              <Icon name="context-menu-more" class="h-4 w-4" />
            </button>
          }
        >
          <Show
            when={typeMenuColumn() === key}
            fallback={
              <>
                <ContextMenuItem
                  onClick={(event) => {
                    closeMenu(event);
                    setRenamingColumn(key);
                  }}
                >
                  <Icon name="edit-entry" class="h-4 w-4 flex-none" />
                  <span class="text-neutral-900">Rename</span>
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => setTypeMenuColumn(key)}
                  class="min-w-[10rem]"
                >
                  <Icon name="generic-property" class="h-4 w-4 flex-none" />
                  <span class="flex-1 text-left text-neutral-900">Type</span>
                  <span class="text-neutral-500">
                    {COLUMN_TYPES.find((option) => option.type === type())?.label}
                  </span>
                  <Icon
                    name="chevron-right-small"
                    class="h-3 w-3 flex-none text-neutral-500"
                  />
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onClick={(event) => {
                    closeMenu(event);
                    void deleteColumnConfirmed(key, label());
                  }}
                >
                  <Icon name="delete-entry" class="h-4 w-4 flex-none text-red-600" />
                  <span class="text-red-600">Delete column</span>
                </ContextMenuItem>
              </>
            }
          >
            <ContextMenuItem
              onClick={() => setTypeMenuColumn(null)}
              class="min-w-[10rem]"
            >
              <Icon name="chevron-left-thin" class="h-4 w-4 flex-none text-neutral-500" />
              <span class="text-neutral-500">Type</span>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <For each={COLUMN_TYPES}>
              {(option) => (
                <ContextMenuItem
                  onClick={(event) => {
                    closeMenu(event);
                    if (option.type !== type()) void changeColumnType(key, option.type);
                  }}
                >
                  <Icon
                    name="confirmation"
                    class={
                      option.type === type()
                        ? "h-4 w-4 flex-none"
                        : "invisible h-4 w-4 flex-none"
                    }
                  />
                  <span class="text-neutral-900">{option.label}</span>
                </ContextMenuItem>
              )}
            </For>
          </Show>
        </ContextMenu>
      </Show>
      {/* Centred on the cell's 1px right border, styled after the sidebar's handle. */}
      <div
        class="absolute top-2 -right-[2.5px] bottom-2 z-10 w-1 cursor-col-resize rounded-[99px] transition-colors hover:bg-neutral-300 active:bg-neutral-300"
        onPointerDown={(event) => startResize(key, event)}
      >
        <div class="absolute -inset-x-1 inset-y-0" />
      </div>
    </div>
  );
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
    renameColumn,
    changeColumnType,
    listColumnValues,
  } = useDatabaseRows(() => props.databaseDocumentId, sort);

  createEffect(() => setSchemaStr(props.schemaJson));

  const rowIds = createMemo(() => rows().map((row) => row.id));
  const { selectedIds, toggleSelect, selectAll, deselectAll } = useSelection(rowIds);
  const allSelected = () => rows().length > 0 && selectedIds().size === rows().length;

  // A shift-click that extends a range leaves the clicked row selected, which
  // the native toggle would otherwise have unchecked.
  function onRowCheckboxClick(rowId: string, event: MouseEvent) {
    toggleSelect(rowId, event);
    (event.currentTarget as HTMLInputElement).checked = selectedIds().has(rowId);
  }

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

  const [renamingColumn, setRenamingColumn] = createSignal<string | null>(null);
  // The column whose menu shows the type options instead of its actions.
  const [typeMenuColumn, setTypeMenuColumn] = createSignal<string | null>(null);

  // Enter and Escape clear the signal first, so the blur that follows is a no-op.
  async function commitRename(from: string, value: string) {
    if (renamingColumn() !== from) return;
    setRenamingColumn(null);
    const to = value.trim();
    if (!to || to === from) return;
    try {
      await renameColumn(from, to);
    } catch (error) {
      toastError(error instanceof Error ? error.message : "Failed to rename column");
      return;
    }
    const current = sort();
    if (current?.key === from) commitSort({ key: to, order: current.order });
  }

  const lang = useLocale();
  const { documents } = useDocuments();
  const documentOptions = createMemo(() =>
    documents().map((document) => documentOption(document, lang)),
  );

  // A row holding several values keeps them; one holding a single value stays single.
  const chipCell = (
    rowId: string,
    properties: DocumentProperties,
    col: DatabaseColumn,
  ) => {
    const isDocument = col.type === "document";
    const value = () => readDocumentProperty(properties, col.name);
    const values = () => {
      const current = value();
      return Array.isArray(current) ? current : current ? [current] : [];
    };
    const labels = () =>
      isDocument
        ? values().map(
            (id) => documentOptions().find((option) => option.id === id)?.label ?? id,
          )
        : values();
    const referenced = () =>
      isDocument && values().length === 1
        ? documents().find((document) => document.id === values()[0])
        : undefined;
    return (
      <div class="flex min-w-0 items-center gap-1">
        <PropertyChip
          variant="quiet"
          icon={isDocument ? "document" : "generic-property"}
          label="—"
          nameLabel={col.label}
          valueLabels={labels()}
          showTooltip={false}
          allowMultiple={Array.isArray(value())}
          property={{
            id: col.name,
            name: col.name,
            type: isDocument ? "document" : "select",
            value: value(),
          }}
          propertyValues={async () =>
            isDocument
              ? documentOptions()
              : (await listColumnValues(col.name)).map((option) => ({
                  id: option,
                  label: option,
                  icon: "generic-property",
                }))
          }
          onUpdate={(updated) =>
            void updateRowProperty(rowId, col.name, updated.value ?? "")
          }
          onDelete={() => void updateRowProperty(rowId, col.name, "")}
        />
        <Show when={referenced()}>
          {(document) => (
            <a
              href={spacePath(currentSpace()?.slug, `/doc/${document().slug}`)}
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-neutral-400 opacity-0 transition-all hover:bg-neutral-100 hover:text-neutral-700 group-hover:opacity-100"
              title="Open document"
            >
              <Icon class="h-3.5 w-3.5" name="chevron-right-small" />
            </a>
          )}
        </Show>
      </div>
    );
  };

  async function deleteSelectedConfirmed() {
    const ids = [...selectedIds()];
    const message = ids.length === 1 ? "Delete this row?" : `Delete ${ids.length} rows?`;
    if (!(await confirmDialog(message, { tone: "danger" }))) return;
    try {
      await Promise.all(ids.map((id) => deleteRow(id)));
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to delete rows");
    }
  }

  async function deleteColumnConfirmed(name: string, label: string) {
    if (!(await confirmDialog(`Delete column "${label}"?`, { tone: "danger" }))) return;
    await deleteColumn(name);
  }

  async function deleteRowConfirmed(rowId: string) {
    if (!(await confirmDialog("Delete this row?", { tone: "danger" }))) return;
    try {
      await deleteRow(rowId);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to delete row");
    }
  }

  createEffect(() => {
    void props.databaseDocumentId;
    setEditingCell(null);
    setRenamingColumn(null);
  });

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
  // inside its own scroller. Hovered headers lift above their neighbour
  // (`hover:z-2!`), which would otherwise cover the overhanging resize handle.
  const stickyHeaderStyle = { position: "sticky", top: "0", "z-index": "1" } as const;

  // Header cells are keyed by name: a column's object is replaced on every
  // schema write, which would rebuild its header.
  const columnNames = createMemo(() => derivedColumns().map((col) => col.name));
  function columnByName(name: string): DatabaseColumn {
    const col = derivedColumns().find((candidate) => candidate.name === name);
    if (!col) throw new Error(`Unknown column "${name}"`);
    return col;
  }

  const { width: columnWidth, startResize } = useColumnWidths({
    key: () => `database-col-widths:${props.databaseDocumentId}`,
    defaultWidth: (col) => (col === "title" ? NAME_COL_WIDTH : DEFAULT_COL_WIDTH),
  });

  const tableWidth = createMemo(
    () =>
      SELECT_COL_WIDTH +
      columnWidth("title") +
      derivedColumns().reduce((sum, col) => sum + columnWidth(col.name), 0) +
      ACTION_COL_WIDTH,
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
    <div class="relative flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-neutral-100">
      <div class="min-h-0 flex-1 overflow-auto">
        <Show
          when={!isLoading()}
          fallback={
            <table
              class="border-separate border-spacing-0 animate-pulse [&_td]:border-neutral-100 [&_td]:border-r [&_td]:border-b [&_th]:border-neutral-100 [&_th]:border-r [&_th]:border-b [&_tr_>_:last-child]:border-r-0"
              style={{ "table-layout": "fixed", width: "100%" }}
            >
              <thead>
                <tr class="bg-neutral-50">
                  <th style={{ width: `${SELECT_COL_WIDTH}px` }} />
                  <th class="px-3 py-2.5" style={{ width: `${NAME_COL_WIDTH}px` }}>
                    <div class="h-2.5 w-16 rounded-full bg-skeleton-strong" />
                  </th>
                  <For each={[0, 1]}>
                    {() => (
                      <th class="px-3 py-2.5" style={{ width: `${DEFAULT_COL_WIDTH}px` }}>
                        <div class="h-2.5 w-14 rounded-full bg-skeleton-strong" />
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
                      <td />
                      <td class="px-3 py-2.5">
                        <div
                          class="h-2.5 rounded-full bg-skeleton"
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
            class="border-separate border-spacing-0 text-size-medium [&_td]:border-neutral-100 [&_td]:border-r [&_td]:border-b [&_td]:leading-[1.45] [&_th]:border-neutral-100 [&_th]:border-r [&_th]:border-b [&_th]:leading-[1.45] [&_tr_>_:last-child]:border-r-0"
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
                  class="bg-neutral-50 p-0 text-center"
                  style={{ ...stickyHeaderStyle, width: `${SELECT_COL_WIDTH}px` }}
                >
                  <input
                    type="checkbox"
                    aria-label="Select all rows"
                    ref={(el) =>
                      createEffect(() => {
                        el.indeterminate = selectedIds().size > 0 && !allSelected();
                      })
                    }
                    checked={allSelected()}
                    disabled={rows().length === 0}
                    onChange={() => (allSelected() ? deselectAll() : selectAll())}
                    class="h-3.5 w-3.5 cursor-pointer accent-primary-500 align-middle"
                  />
                </th>
                <th
                  class="relative whitespace-nowrap bg-neutral-50 p-0 font-semibold text-neutral-700 text-size-small hover:z-2!"
                  style={{ ...stickyHeaderStyle, width: `${columnWidth("title")}px` }}
                  aria-sort={ariaSort("title")}
                >
                  {columnHeader(
                    "title",
                    () => "Name",
                    () => undefined,
                  )}
                </th>

                <For each={columnNames()}>
                  {(name) => (
                    <th
                      class="whitespace-nowrap bg-neutral-50 p-0 font-semibold text-neutral-700 text-size-small hover:z-2!"
                      style={{
                        ...stickyHeaderStyle,
                        width: `${columnWidth(name)}px`,
                      }}
                      aria-sort={ariaSort(name)}
                    >
                      {columnHeader(
                        name,
                        () => columnByName(name).label,
                        () => columnByName(name).type,
                      )}
                    </th>
                  )}
                </For>

                {/* Unsized, so it takes up the slack when the table is narrower than its
                    container; sized columns then keep their width while resizing. */}
                <th class="bg-neutral-50 px-2" style={stickyHeaderStyle}>
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
                            <For each={COLUMN_TYPES}>
                              {(option) => (
                                <option value={option.type}>{option.label}</option>
                              )}
                            </For>
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
                    colspan={derivedColumns().length + 3}
                    class="border-0! p-0!"
                    style={{ height: `${spacerBefore()}px` }}
                  />
                </tr>
              </Show>

              <For each={visibleRows()}>
                {(row) => (
                  <tr
                    class="group"
                    classList={{ "bg-primary-50": selectedIds().has(row.id) }}
                    data-row
                  >
                    <td class="p-0 text-center align-middle">
                      <input
                        type="checkbox"
                        aria-label={`Select ${rowTitle(row.properties)}`}
                        checked={selectedIds().has(row.id)}
                        onClick={(event) => onRowCheckboxClick(row.id, event)}
                        class="h-3.5 w-3.5 cursor-pointer accent-primary-500 align-middle opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
                        classList={{ "opacity-100!": selectedIds().size > 0 }}
                      />
                    </td>
                    <td
                      class="px-3 py-2.5 align-top"
                      style={{ width: `${columnWidth("title")}px` }}
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
                        <Show
                          when={col.type !== "select" && col.type !== "document"}
                          fallback={
                            <td
                              class="px-1.5 py-1.5 align-top"
                              style={{ width: `${columnWidth(col.name)}px` }}
                            >
                              {chipCell(row.id, row.properties, col)}
                            </td>
                          }
                        >
                          {/* biome-ignore lint/a11y/useKeyWithClickEvents: the row link and the edit button are the keyboard paths. */}
                          <td
                            class="cursor-text px-3 py-2.5 align-top transition-colors hover:bg-neutral-50"
                            classList={{
                              "bg-background! shadow-[inset_0_0_0_2px_var(--color-primary-400)]":
                                editingCell()?.rowId === row.id &&
                                editingCell()?.col === col.name,
                            }}
                            style={{ width: `${columnWidth(col.name)}px` }}
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
                                  class="min-h-[1.25rem] truncate text-neutral-700"
                                  classList={{
                                    "text-neutral-300 italic": !cellValue(
                                      row.properties,
                                      col.name,
                                    ),
                                  }}
                                >
                                  <Show
                                    when={cellHref(cellValue(row.properties, col.name))}
                                    fallback={cellValue(row.properties, col.name) || "—"}
                                  >
                                    {(href) => (
                                      <a
                                        href={href()}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        class="text-primary-600 hover:underline"
                                        onClick={(event) => event.stopPropagation()}
                                      >
                                        {cellValue(row.properties, col.name)}
                                      </a>
                                    )}
                                  </Show>
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
                        </Show>
                      )}
                    </For>

                    <td class="px-2 align-middle">
                      <button
                        type="button"
                        class="flex h-6 w-6 items-center justify-center rounded text-neutral-400 opacity-0 transition-all hover:bg-neutral-100 hover:text-red-500 group-hover:opacity-100"
                        title="Delete row"
                        onClick={() => void deleteRowConfirmed(row.id)}
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
                    colspan={derivedColumns().length + 3}
                    class="border-0! p-0!"
                    style={{ height: `${spacerAfter()}px` }}
                  />
                </tr>
              </Show>

              <Show when={rows().length === 0 && !isLoading()}>
                <tr>
                  <td
                    colspan={derivedColumns().length + 3}
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

      <div class="flex shrink-0 items-center justify-between gap-3 border-neutral-100 border-t px-3 py-2">
        <Show
          when={selectedIds().size > 0}
          fallback={
            <button
              type="button"
              class="inline-flex items-center gap-1.5 text-neutral-400 text-size-small transition-colors hover:text-neutral-700"
              onClick={() => void addRow()}
            >
              <Icon class="h-3.5 w-3.5" name="add" />
              New row
            </button>
          }
        >
          <div class="flex items-center gap-3 text-size-small">
            <span class="text-neutral-500 tabular-nums">
              {selectedIds().size} selected
            </span>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 text-red-600 transition-colors hover:text-red-700"
              onClick={() => void deleteSelectedConfirmed()}
            >
              <Icon class="h-3.5 w-3.5" name="delete-entry" />
              Delete
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 text-neutral-400 transition-colors hover:text-neutral-700"
              onClick={deselectAll}
            >
              <Icon class="h-3.5 w-3.5" name="cancel" />
              Deselect
            </button>
          </div>
        </Show>
        <div class="flex items-center gap-3">
          <span class="text-neutral-400 text-size-small">{rows().length} rows</span>
          <input
            ref={importInputRef}
            type="file"
            accept=".csv,text/csv,.ics,text/calendar"
            class="hidden"
            onChange={(event) => void onImportFileChange(event)}
          />
          <button
            type="button"
            class="inline-flex items-center gap-1.5 text-neutral-400 text-size-small transition-colors hover:text-neutral-700 disabled:pointer-events-none disabled:opacity-50"
            title="Import"
            disabled={isImporting()}
            onClick={openImportPicker}
          >
            <Icon class="h-3.5 w-3.5" name="csv-file" />
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
