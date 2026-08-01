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

import { Model } from "@ironcalc/wasm";
import {
  cellsToHtmlTable,
  htmlTableToCells,
  type TableCell,
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
  const rows = htmlTableToCells(html);
  if (!rows || rows.length === 0) return model;

  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  if (width === 0) return model;

  model.pasteCsvText(
    { sheet: SHEET, row: FIRST, column: FIRST, width, height: rows.length },
    cellsToTsv(rows),
  );
  model.evaluate();
  // A paste leaves everything it wrote selected. Opening a document should look
  // like opening a file: the top-left cell, nothing highlighted.
  model.setSelectedCell(FIRST, FIRST);
  model.setSelectedRange(FIRST, FIRST, FIRST, FIRST);
  return model;
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
  const { rows, columns } = usedExtent(model);
  const lastRow = rows[rows.length - 1];
  const lastColumn = columns[columns.length - 1];
  if (lastRow === undefined || lastColumn === undefined) {
    return cellsToHtmlTable([]);
  }

  const grid: TableCell[][] = [];
  for (let row = FIRST; row <= lastRow; row++) {
    const cells: TableCell[] = [];
    for (let column = FIRST; column <= lastColumn; column++) {
      const value = model.getFormattedCellValue(SHEET, row, column);
      const source = model.getCellContent(SHEET, row, column);
      cells.push(source === value ? { value } : { value, source });
    }
    grid.push(cells);
  }

  return cellsToHtmlTable(grid);
}
