/**
 * The collaborative shape of a `csv` document.
 *
 * Runs on both sides: the server builds one of these when a room opens and
 * serializes it back to the stored `<table>` markup, and the browser keeps it in
 * step with its IronCalc model. Nothing here touches the DOM or the engine.
 *
 * The layout is chosen for how a spreadsheet is actually edited:
 *
 *     rows     Y.Array of Y.Map — one per row, so inserting or deleting a row
 *              is a single array operation that merges properly. Each map is
 *              keyed by column index, plus `h` for the row's height.
 *     columns  Y.Map of width by column index.
 *
 * A cell is one value in its row's map, so two people editing different cells
 * never touch the same key and both edits survive; the same cell resolves
 * last-writer-wins, which is what Yjs gives and what people expect.
 *
 * Each cell carries what the markup carries — the displayed value, the raw
 * input behind it, and the style difference. Keeping the *displayed* value in
 * the document is what lets the server write the markup without an engine to
 * recompute formulas with: the client that made the edit already knows it.
 */

import * as Y from "yjs";
import {
  cellsToHtmlTable,
  htmlTableToTable,
  type TableCell,
  type TableLayout,
} from "#documents/htmlTable.ts";

/** Reserved key inside a row map; column keys are numeric strings. */
const HEIGHT_KEY = "h";

export const SHEET_ROWS = "rows";
export const SHEET_COLUMNS = "columns";

/** A cell as it lives in the document — the same three parts as the markup. */
export interface SheetCell {
  /** What the cell displays. `v` for brevity: there is one per cell. */
  v: string;
  /** The raw input, when it differs from the value (a formula, forced text). */
  i?: string;
  /** The style difference from the default; see `csvDocument.ts`. */
  s?: Record<string, unknown>;
}

export type SheetRows = Y.Array<Y.Map<unknown>>;
export type SheetColumns = Y.Map<number>;

export function sheetRows(doc: Y.Doc): SheetRows {
  return doc.getArray<Y.Map<unknown>>(SHEET_ROWS);
}

export function sheetColumns(doc: Y.Doc): SheetColumns {
  return doc.getMap<number>(SHEET_COLUMNS);
}

export function rowHeight(row: Y.Map<unknown>): number | undefined {
  const height = row.get(HEIGHT_KEY);
  return typeof height === "number" ? height : undefined;
}

export function setRowHeight(row: Y.Map<unknown>, height: number | undefined): void {
  if (height === undefined) row.delete(HEIGHT_KEY);
  else row.set(HEIGHT_KEY, height);
}

export function readCell(row: Y.Map<unknown>, column: number): SheetCell | undefined {
  const cell = row.get(String(column));
  return isSheetCell(cell) ? cell : undefined;
}

function isSheetCell(value: unknown): value is SheetCell {
  return typeof value === "object" && value !== null && "v" in value;
}

/** How wide the row is, ignoring the height key. */
export function rowWidth(row: Y.Map<unknown>): number {
  let width = 0;
  for (const key of row.keys()) {
    const column = Number.parseInt(key, 10);
    if (Number.isInteger(column)) width = Math.max(width, column + 1);
  }
  return width;
}

function toSheetCell(cell: TableCell): SheetCell | undefined {
  // An empty cell is stored by leaving the key out, so a sparse sheet stays
  // sparse and a cleared cell is a delete rather than a tombstone.
  if (cell.value === "" && cell.source === undefined && cell.style === undefined) {
    return undefined;
  }
  return {
    v: cell.value,
    ...(cell.source === undefined ? {} : { i: cell.source }),
    ...(cell.style === undefined ? {} : { s: cell.style }),
  };
}

function toTableCell(cell: SheetCell | undefined): TableCell {
  if (!cell) return { value: "" };
  return {
    value: cell.v,
    ...(cell.i === undefined ? {} : { source: cell.i }),
    ...(cell.s === undefined ? {} : { style: cell.s }),
  };
}

/** The document's cells and sizes, as the markup writer wants them. */
export function sheetDocToTable(doc: Y.Doc): {
  cells: TableCell[][];
  layout: TableLayout;
} {
  const rows = sheetRows(doc);
  const columns = sheetColumns(doc);

  let width = 0;
  for (const row of rows) width = Math.max(width, rowWidth(row));
  for (const key of columns.keys()) {
    const column = Number.parseInt(key, 10);
    if (Number.isInteger(column)) width = Math.max(width, column + 1);
  }

  const cells = rows.map((row) =>
    Array.from({ length: width }, (_, column) => toTableCell(readCell(row, column))),
  );

  const columnWidths = Array.from({ length: width }, (_, column) =>
    columns.get(String(column)),
  );
  const rowHeights = rows.map((row) => rowHeight(row));

  return {
    cells,
    layout: {
      ...(columnWidths.some((value) => value !== undefined) ? { columnWidths } : {}),
      ...(rowHeights.some((value) => value !== undefined) ? { rowHeights } : {}),
    },
  };
}

/** Fills an empty document from cells and sizes. */
export function fillSheetDoc(
  doc: Y.Doc,
  cells: TableCell[][],
  layout: TableLayout = {},
): void {
  doc.transact(() => {
    const rows = sheetRows(doc);
    const columns = sheetColumns(doc);
    rows.delete(0, rows.length);
    for (const key of [...columns.keys()]) columns.delete(key);

    rows.insert(
      0,
      cells.map((line, rowIndex) => {
        const row = new Y.Map<unknown>();
        line.forEach((cell, column) => {
          const value = toSheetCell(cell);
          if (value) row.set(String(column), value);
        });
        const height = layout.rowHeights?.[rowIndex];
        if (height !== undefined) row.set(HEIGHT_KEY, height);
        return row;
      }),
    );

    layout.columnWidths?.forEach((width, column) => {
      if (width !== undefined) columns.set(String(column), width);
    });
  });
}

/** The stored markup as a fresh collaborative document. */
export function sheetDocFromHtml(html: string): Y.Doc {
  const doc = new Y.Doc();
  const table = htmlTableToTable(html);
  if (table) fillSheetDoc(doc, table.cells, table.layout);
  return doc;
}

/** The collaborative document as the markup a csv document stores. */
export function htmlFromSheetDoc(doc: Y.Doc): string {
  const { cells, layout } = sheetDocToTable(doc);
  return cellsToHtmlTable(cells, layout);
}
