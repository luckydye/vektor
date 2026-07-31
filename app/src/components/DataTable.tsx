import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { downloadIcon } from "#assets/icons.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { spacePath } from "#utils/utils.ts";
import type { ExcelCell, ExcelCellFill, ExcelSheet } from "#utils/xlsx.ts";
import { downloadExcelSheets, sanitizeSheetName } from "#utils/xlsx.ts";
import type { ExcelExportConfig } from "./ExcelExportDialog.tsx";
import { ExcelExportDialog } from "./ExcelExportDialog.tsx";

interface Props {
  data: Record<string, unknown>[];
  documentId?: string;
  exportFileName?: string;
}

const PAGE_SIZE = 10;
const DEFAULT_COL_WIDTH = 200;

const STATUS_MARKER = /(?:^|[^\p{L}\p{N}_])(ROT|GELB|GREEN|GRÜN)(?=$|[^\p{L}\p{N}_])/u;

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function statusFill(value: unknown): ExcelCellFill | undefined {
  const marker = cellText(value).match(STATUS_MARKER)?.[1];
  if (marker === "ROT") return "red";
  if (marker === "GELB") return "yellow";
  if (marker === "GREEN" || marker === "GRÜN") return "green";
  return undefined;
}

function exportCell(value: unknown, fill = statusFill(value)): ExcelCell {
  const text = cellText(value);
  return fill ? { text, fill } : text;
}

function exportRow(values: unknown[]): ExcelCell[] {
  const fill = values.map(statusFill).find((candidate) => candidate !== undefined);
  return values.map((value) => exportCell(value, fill));
}

function exportSummaryRow(column: string, value: unknown): ExcelCell[] {
  const fill = statusFill(value);
  return [
    fill ? { text: column, bold: true, fill } : { text: column, bold: true },
    exportCell(value, fill),
  ];
}

function parseBoldSection(text: string): Record<string, string> | null {
  // Match **Heading** followed by its content up to the next **Heading** or end
  const regex = /\*\*([^*\n]+)\*\*\s*\n?([\s\S]*?)(?=\n\*\*[^*\n]+\*\*|$)/g;
  const result: Record<string, string> = {};
  let found = false;
  for (const match of text.matchAll(regex)) {
    found = true;
    result[match[1].trim()] = match[2].trim();
  }
  return found ? result : null;
}

function buildSubSheetRows(sections: string[], parseBold: boolean): ExcelCell[][] {
  if (!parseBold) return sections.map((s) => exportRow([s]));

  // The 0th section is an intro/summary block (e.g. "Notiz"), not a record — skip it.
  const recordSections = sections.slice(1);

  const parsed = recordSections
    .map(parseBoldSection)
    .filter((r): r is Record<string, string> => r !== null);
  if (parsed.length === 0) return recordSections.map((s) => exportRow([s]));

  // Union of all keys in order of first appearance
  const keyOrder: string[] = [];
  const keySet = new Set<string>();
  for (const record of parsed) {
    for (const k of Object.keys(record)) {
      if (!keySet.has(k)) {
        keySet.add(k);
        keyOrder.push(k);
      }
    }
  }

  const headerRow: ExcelCell[] = keyOrder.map((k) => ({ text: k, bold: true }));
  return [headerRow, ...parsed.map((r) => exportRow(keyOrder.map((k) => r[k])))];
}

function isDocumentIdColumn(column: string): boolean {
  return column.toLowerCase().includes("documentid");
}

export function DataTable(props: Props) {
  const { currentSpace } = useSpace();

  const [filter, setFilter] = createSignal("");
  const [page, setPage] = createSignal(0);
  const [sortCol, setSortCol] = createSignal<string | null>(null);
  const [sortAsc, setSortAsc] = createSignal(true);
  const [focusedRow, setFocusedRow] = createSignal<number | null>(null);

  createEffect(on(filter, () => setPage(0), { defer: true }));

  function toggleSort(col: string) {
    if (sortCol() === col) {
      setSortAsc(!sortAsc());
    } else {
      setSortCol(col);
      setSortAsc(true);
    }
    setPage(0);
  }

  const columns = createMemo(() => {
    if (props.data.length === 0) return [];
    return Object.keys(props.data[0]);
  });

  const filtered = createMemo(() => {
    const q = filter().trim().toLowerCase();
    let rows = q
      ? props.data.filter((row) =>
          Object.values(row).some((v) =>
            String(v ?? "")
              .toLowerCase()
              .includes(q),
          ),
        )
      : props.data;
    const col = sortCol();
    if (col) {
      const asc = sortAsc() ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const av = a[col] ?? "";
        const bv = b[col] ?? "";
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * asc;
        return String(av).localeCompare(String(bv)) * asc;
      });
    }
    return rows;
  });

  const pageCount = createMemo(() =>
    Math.max(1, Math.ceil(filtered().length / PAGE_SIZE)),
  );
  const paginated = createMemo(() =>
    filtered().slice(page() * PAGE_SIZE, (page() + 1) * PAGE_SIZE),
  );

  const [showExportDialog, setShowExportDialog] = createSignal(false);

  function handleExportDownload(config: ExcelExportConfig) {
    setShowExportDialog(false);
    const tableColumns = columns();
    const rows = filtered();

    const overviewRows = [
      tableColumns,
      ...rows.map((row) => exportRow(tableColumns.map((col) => row[col]))),
    ];

    const sheets: ExcelSheet[] = [{ name: "Overview", rows: overviewRows }];
    const usedNames = new Set(["Overview"]);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      let baseName =
        sanitizeSheetName(cellText(row[config.sheetNameColumn]).trim()) || `Row ${i + 1}`;
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
        ? content
            .split(del)
            .map((s) => s.trim())
            .filter(Boolean)
        : [content];

      const summaryCols = tableColumns.slice(0, config.summaryColumnCount);
      const summaryRows: ExcelCell[][] = summaryCols.map((col) =>
        exportSummaryRow(col, row[col]),
      );
      const subRows = buildSubSheetRows(sections, config.parseBoldHeadings);

      sheets.push({ name: sheetName, rows: [...summaryRows, [], ...subRows] });
    }

    downloadExcelSheets(sheets, props.exportFileName ?? "data.xlsx");
  }

  function documentHref(column: string, value: unknown): string | null {
    if (!isDocumentIdColumn(column)) return null;
    const text = cellText(value).trim();
    if (!text) return null;
    return spacePath(currentSpace()?.slug, `/doc/${encodeURIComponent(text)}`);
  }

  // Column resizing
  const storageKey = createMemo(() =>
    props.documentId ? `datatable-col-widths-${props.documentId}` : null,
  );
  const [columnWidths, setColumnWidths] = createSignal<Record<string, number>>({});

  onMount(() => {
    const key = storageKey();
    if (!key) return;
    try {
      const saved = sessionStorage.getItem(key);
      if (saved) setColumnWidths(JSON.parse(saved));
    } catch {}
  });

  function colWidth(col: string): string {
    return `${columnWidths()[col] ?? DEFAULT_COL_WIDTH}px`;
  }

  let resizeCol: string | null = null;
  let resizeStartX = 0;
  let resizeStartWidth = 0;

  function onResizeMouseMove(e: MouseEvent) {
    if (!resizeCol) return;
    const newWidth = Math.max(80, resizeStartWidth + (e.clientX - resizeStartX));
    setColumnWidths({ ...columnWidths(), [resizeCol]: newWidth });
  }

  function onResizeMouseUp() {
    resizeCol = null;
    document.removeEventListener("mousemove", onResizeMouseMove);
    document.removeEventListener("mouseup", onResizeMouseUp);
    const key = storageKey();
    if (key) sessionStorage.setItem(key, JSON.stringify(columnWidths()));
  }

  function onResizeMouseDown(col: string, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    resizeCol = col;
    resizeStartX = e.clientX;
    resizeStartWidth = columnWidths()[col] ?? DEFAULT_COL_WIDTH;
    document.addEventListener("mousemove", onResizeMouseMove);
    document.addEventListener("mouseup", onResizeMouseUp);
  }

  onCleanup(() => {
    if (typeof document === "undefined") return;
    document.removeEventListener("mousemove", onResizeMouseMove);
    document.removeEventListener("mouseup", onResizeMouseUp);
  });

  return (
    <div>
      <Show when={showExportDialog()}>
        <ExcelExportDialog
          columns={columns()}
          rowCount={filtered().length}
          onCancel={() => setShowExportDialog(false)}
          onDownload={handleExportDownload}
        />
      </Show>
      <div class="flex h-9 items-center gap-3 border-neutral-100 border-b bg-neutral-50 px-4">
        <input
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          type="text"
          placeholder="Filter…"
          class="min-w-0 flex-1 bg-transparent text-neutral-800 text-size-medium placeholder:text-neutral-400 focus:outline-none"
        />
        <div class="flex shrink-0 items-center gap-2 text-neutral-400 text-size-small">
          <span>
            {filtered().length} / {props.data.length} rows
          </span>
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-sm border border-neutral-200 bg-background px-2 py-0.5 text-neutral-600 transition-colors hover:border-neutral-300 hover:bg-neutral-50"
            title="Download as Excel"
            onClick={() => setShowExportDialog(true)}
          >
            <div class="svg-icon h-3.5 w-3.5" innerHTML={downloadIcon} />
            Excel
          </button>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table
          class="text-size-medium"
          style={{ "table-layout": "fixed", width: "max-content", "min-width": "100%" }}
        >
          <thead>
            <tr class="bg-neutral-50 text-left">
              <For each={columns()}>
                {(col) => (
                  // biome-ignore lint/a11y/noStaticElementInteractions: a <th> is the sort control here.
                  // biome-ignore lint/a11y/useKeyWithClickEvents: sorting is a pointer affordance on this table.
                  <th
                    class="relative cursor-pointer select-none overflow-hidden whitespace-nowrap border-neutral-100 border-b px-4 py-2 font-medium text-neutral-500 text-size-small uppercase tracking-wide hover:text-neutral-700"
                    style={{ width: colWidth(col) }}
                    onClick={() => toggleSort(col)}
                  >
                    <span class="inline-flex items-center gap-1 truncate">
                      {col}
                      <span class="shrink-0 opacity-50">
                        {sortCol() === col ? (sortAsc() ? "↑" : "↓") : "↕"}
                      </span>
                    </span>
                    {/* Resize handle */}
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer-only resize affordance; keyboard resizing has no equivalent here. */}
                    <div
                      class="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-neutral-300 active:bg-neutral-400"
                      onMouseDown={(event) => onResizeMouseDown(col, event)}
                    />
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <Index each={paginated()}>
              {(row, i) => (
                // biome-ignore lint/a11y/useKeyWithClickEvents: the row is focusable and the click only mirrors focus.
                <tr
                  tabindex="0"
                  class="cursor-pointer border-neutral-100 border-b outline-none transition-colors hover:bg-neutral-50"
                  classList={{ "bg-primary-50": focusedRow() === i }}
                  onFocus={() => setFocusedRow(i)}
                  onBlur={() => setFocusedRow(null)}
                  onClick={() => setFocusedRow(i)}
                >
                  <For each={columns()}>
                    {(col) => (
                      <td
                        class="px-4 py-2.5 align-top text-neutral-700"
                        style={{ width: colWidth(col), "max-width": colWidth(col) }}
                      >
                        <div
                          class="max-h-24 overflow-y-auto whitespace-pre-wrap break-words"
                          title={cellText(row()[col])}
                        >
                          <Show
                            when={documentHref(col, row()[col])}
                            fallback={cellText(row()[col])}
                          >
                            {(href) => (
                              <a
                                href={href()}
                                class="text-sky-700 hover:text-sky-800 hover:underline"
                                target="_blank"
                                rel="noreferrer"
                              >
                                {cellText(row()[col])}
                              </a>
                            )}
                          </Show>
                        </div>
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </Index>
            <Show when={filtered().length === 0}>
              <tr>
                <td
                  colspan={columns().length}
                  class="px-4 py-4 text-center text-neutral-400 text-size-small"
                >
                  No results
                </td>
              </tr>
            </Show>
          </tbody>
        </table>
      </div>
      <Show when={pageCount() > 1}>
        <div class="flex items-center justify-end gap-1 px-4 pt-3 text-neutral-400 text-size-small">
          <button
            type="button"
            class="rounded-sm border border-neutral-200 px-2 py-0.5 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-30"
            disabled={page() === 0}
            onClick={() => setPage(page() - 1)}
          >
            ←
          </button>
          <span>
            {page() + 1} / {pageCount()}
          </span>
          <button
            type="button"
            class="rounded-sm border border-neutral-200 px-2 py-0.5 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-30"
            disabled={page() >= pageCount() - 1}
            onClick={() => setPage(page() + 1)}
          >
            →
          </button>
        </div>
      </Show>
    </div>
  );
}
