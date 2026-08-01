/**
 * Moves a `csv` document between its stored `<table>` markup and an IronCalc
 * `Model`. See `#documents/htmlTable.ts` for the markup itself.
 *
 * Loading goes through `pasteCsvText`, which takes the whole grid in one call.
 * That matters more than it looks: filling a 2000x12 sheet with `setUserInput`
 * takes ~40s, the same data through `pasteCsvText` ~80ms. Per-cell writes are
 * for what the user types, never for bulk.
 *
 * `pasteCsvText` is tab-separated despite the name, and parses each cell the
 * way typing it would: `42` becomes a number, `=SUM(A1:A2)` a formula, and a
 * leading apostrophe forces text. So a cell's stored `data-source` can be
 * handed over verbatim and comes back as whatever it was.
 */

import { type CellStyle, Model } from "@ironcalc/wasm";
import {
  cellsToHtmlTable,
  htmlTableToTable,
  type TableCell,
  type TableLayout,
} from "#documents/htmlTable.ts";

/** Documents hold a single sheet, and IronCalc counts rows/columns from 1. */
const SHEET = 0;
const FIRST = 1;

/**
 * How wide a band of columns to search for occupied rows. The engine can only
 * answer "which rows have data in column N", so finding the used range means
 * starting somewhere; this covers the loaded width plus room for columns the
 * user added to the right of it.
 */
const EXTENT_SEED_COLUMNS = 32;

/**
 * The style a cell has when nothing has been done to it.
 *
 * Read from the engine rather than written out here, so it cannot drift from
 * whatever IronCalc considers default. Cached: it is the same for every cell of
 * every document, and building a throwaway `Model` is not free.
 */
let defaults: { style: CellStyle; columnWidth: number; rowHeight: number } | undefined;

function getDefaults(): { style: CellStyle; columnWidth: number; rowHeight: number } {
  if (!defaults) {
    const model = new Model("default", "en", "UTC", "en");
    defaults = {
      style: model.getCellStyle(SHEET, FIRST, FIRST).style,
      columnWidth: model.getColumnWidth(SHEET, FIRST),
      rowHeight: model.getRowHeight(SHEET, FIRST),
    };
  }
  return defaults;
}

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What `style` has that `base` does not, recursively.
 *
 * A full `CellStyle` is ~130 bytes of overwhelmingly default values, and the
 * document carries one per cell, so only the difference is stored:
 * `{"font":{"b":true}}` rather than the whole thing.
 */
function styleDiff(style: Json, base: Json): Json {
  const diff: Json = {};
  for (const [key, value] of Object.entries(style)) {
    const baseValue = base[key];
    if (isPlainObject(value) && isPlainObject(baseValue)) {
      const nested = styleDiff(value, baseValue);
      if (Object.keys(nested).length > 0) diff[key] = nested;
    } else if (JSON.stringify(value) !== JSON.stringify(baseValue)) {
      diff[key] = value;
    }
  }
  return diff;
}

/** `styleDiff` undone: the stored difference laid back over the default. */
function mergeStyle(base: Json, diff: Json): Json {
  const merged: Json = { ...base };
  for (const [key, value] of Object.entries(diff)) {
    const baseValue = merged[key];
    merged[key] =
      isPlainObject(value) && isPlainObject(baseValue)
        ? mergeStyle(baseValue, value)
        : value;
  }
  return merged;
}

function escapeTsvCell(value: string): string {
  return /["\t\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function cellsToTsv(rows: TableCell[][]): string {
  return rows
    .map((row) => row.map((cell) => escapeTsvCell(cell.source ?? cell.value)).join("\t"))
    .join("\n");
}

/**
 * A model holding the document's grid.
 *
 * Cells arrive as text and are typed on the way in, exactly as a spreadsheet
 * opening a CSV would type them: `0012` becomes the number 12, `=1+1` becomes a
 * formula. Once a cell has been through here and saved it carries its own
 * `data-source` and is pinned to whatever it became.
 */
export function createModel(html: string, name: string): Model {
  const model = new Model(name, "en", "UTC", "en");
  const table = htmlTableToTable(html);
  if (!table || table.cells.length === 0) return model;

  const rows = table.cells;
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  if (width === 0) return model;

  model.pasteCsvText(
    { sheet: SHEET, row: FIRST, column: FIRST, width, height: rows.length },
    cellsToTsv(rows),
  );
  model.evaluate();
  applyStyles(model, rows, width);
  applyLayout(model, table.layout);
  // A paste leaves everything it wrote selected. Opening a document should look
  // like opening a file: the top-left cell, nothing highlighted.
  model.setSelectedCell(FIRST, FIRST);
  model.setSelectedRange(FIRST, FIRST, FIRST, FIRST);
  return model;
}

/**
 * Restores formatting, in one call.
 *
 * `onPasteStyles` takes a rectangle of styles and applies it to the current
 * selection, so the whole grid is selected first. Per-cell `updateRangeStyle`
 * would work too, and is far slower: this is ~40ms for a 1000x12 sheet.
 */
function applyStyles(model: Model, rows: TableCell[][], width: number): void {
  if (!rows.some((row) => row.some((cell) => cell.style))) return;

  const base = getDefaults().style as unknown as Json;
  const grid = rows.map((row) =>
    Array.from({ length: width }, (_, column) => {
      const style = row[column]?.style;
      return (style ? mergeStyle(base, style) : base) as unknown as CellStyle;
    }),
  );

  model.setSelectedCell(FIRST, FIRST);
  model.setSelectedRange(FIRST, FIRST, FIRST + rows.length - 1, FIRST + width - 1);
  model.onPasteStyles(grid);
}

/** Column widths and row heights, which the grid cannot infer from contents. */
function applyLayout(model: Model, layout: TableLayout): void {
  layout.columnWidths?.forEach((columnWidth, index) => {
    if (columnWidth === undefined) return;
    model.setColumnsWidth(SHEET, FIRST + index, FIRST + index, columnWidth);
  });
  layout.rowHeights?.forEach((rowHeight, index) => {
    if (rowHeight === undefined) return;
    model.setRowsHeight(SHEET, FIRST + index, FIRST + index, rowHeight);
  });
}

/**
 * The rows and columns holding data. The engine indexes cells by row, so rows
 * are found per column and columns per row; each answer widens the search for
 * the other until neither grows.
 */
function usedExtent(model: Model): { rows: number[]; columns: number[] } {
  const rows = new Set<number>();
  const columns = new Set<number>();
  let pendingColumns: number[] = Array.from(
    { length: EXTENT_SEED_COLUMNS },
    (_, index) => FIRST + index,
  );
  let pendingRows: number[] = [];

  while (pendingColumns.length > 0 || pendingRows.length > 0) {
    const nextRows: number[] = [];
    for (const column of pendingColumns) {
      if (columns.has(column)) continue;
      columns.add(column);
      for (const row of model.getRowsWithData(SHEET, column)) {
        if (!rows.has(row)) nextRows.push(row);
      }
    }
    pendingColumns = [];

    const nextColumns: number[] = [];
    for (const row of [...pendingRows, ...nextRows]) {
      if (rows.has(row)) continue;
      rows.add(row);
      for (const column of model.getColumnsWithData(SHEET, row)) {
        if (!columns.has(column)) nextColumns.push(column);
      }
    }
    pendingRows = [];
    pendingColumns = nextColumns;
  }

  // The seed marks columns as searched whether or not they held anything, so
  // narrow back down to what is actually occupied before reporting a width.
  const occupiedColumns = new Set<number>();
  for (const row of rows) {
    for (const column of model.getColumnsWithData(SHEET, row))
      occupiedColumns.add(column);
  }

  // Both come out of hash maps, in no particular order.
  return {
    rows: [...rows].sort((a, b) => a - b),
    columns: [...occupiedColumns].sort((a, b) => a - b),
  };
}

/**
 * The model as the document's stored markup. Rows and columns are emitted as a
 * dense rectangle from A1 to the last occupied cell, so the gaps a spreadsheet
 * allows become the empty cells a table needs.
 */
export function toDocumentHtml(model: Model): string {
  const { cells, layout } = readSheet(model);
  return cellsToHtmlTable(cells, layout);
}

/**
 * The model's grid, as cells and sizes. Shared by the save path and the
 * collaborative one, which needs the same view to diff against the room.
 */
export function readSheet(model: Model): { cells: TableCell[][]; layout: TableLayout } {
  const { rows, columns } = usedExtent(model);
  const lastRow = rows[rows.length - 1];
  const lastColumn = columns[columns.length - 1];
  if (lastRow === undefined || lastColumn === undefined) {
    return { cells: [], layout: {} };
  }

  const base = getDefaults().style as unknown as Json;
  const grid: TableCell[][] = [];
  for (let row = FIRST; row <= lastRow; row++) {
    const cells: TableCell[] = [];
    for (let column = FIRST; column <= lastColumn; column++) {
      const value = model.getFormattedCellValue(SHEET, row, column);
      const source = model.getCellContent(SHEET, row, column);
      const style = styleDiff(
        model.getCellStyle(SHEET, row, column).style as unknown as Json,
        base,
      );
      cells.push({
        value,
        ...(source === value ? {} : { source }),
        ...(Object.keys(style).length === 0 ? {} : { style }),
      });
    }
    grid.push(cells);
  }

  return { cells: grid, layout: readLayout(model, lastRow, lastColumn) };
}

/** The widths and heights that have been changed from the default. */
function readLayout(model: Model, lastRow: number, lastColumn: number): TableLayout {
  const { columnWidth, rowHeight } = getDefaults();
  const columnWidths: (number | undefined)[] = [];
  for (let column = FIRST; column <= lastColumn; column++) {
    const width = model.getColumnWidth(SHEET, column);
    columnWidths.push(width === columnWidth ? undefined : width);
  }
  const rowHeights: (number | undefined)[] = [];
  for (let row = FIRST; row <= lastRow; row++) {
    const height = model.getRowHeight(SHEET, row);
    rowHeights.push(height === rowHeight ? undefined : height);
  }
  return { columnWidths, rowHeights };
}
