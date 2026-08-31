/**
 * Lands a peer's grid on a live model instead of rebuilding one.
 *
 * Recreating the model is what the node view used to do, and it disposes the
 * Solid tree that holds the cell editor — so any peer's edit threw away
 * whatever the local user was typing. Writing the difference into the existing
 * model leaves the editor, the selection and the scroll position alone.
 */

import { type CellStyle, Model } from "@ironcalc/wasm";
import { readSheet } from "@vektorapp/spreadsheet/model";
import type { TableCell, TableLayout } from "@vektorapp/spreadsheet/table";

const SHEET = 0;
const FIRST = 1;

type Json = Record<string, unknown>;

/**
 * The style a cell has when nothing has been done to it. Stored styles are
 * diffs against it, so laying one back down needs the whole thing; read from
 * the engine rather than written out, and cached because building a throwaway
 * `Model` is not free.
 */
let defaults: CellStyle | undefined;

function baseStyle(): CellStyle {
  if (!defaults) {
    const probe = new Model("default", "en", "UTC", "en");
    defaults = probe.getCellStyle(SHEET, FIRST, FIRST).style;
    probe.free();
  }
  return defaults;
}

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function gridWidth(cells: TableCell[][]): number {
  return cells.reduce((widest, row) => Math.max(widest, row.length), 0);
}

/** What a cell was typed as, which is what `setUserInput` wants back. */
function input(cell: TableCell | undefined): string | undefined {
  return cell && (cell.source ?? cell.value);
}

function sameStyle(a: TableCell | undefined, b: TableCell | undefined): boolean {
  return JSON.stringify(a?.style ?? null) === JSON.stringify(b?.style ?? null);
}

function applyLayout(model: Model, layout: TableLayout, previous: TableLayout): void {
  layout.columnWidths?.forEach((width, index) => {
    if (width === undefined || width === previous.columnWidths?.[index]) return;
    model.setColumnsWidth(SHEET, FIRST + index, FIRST + index, width);
  });
  layout.rowHeights?.forEach((height, index) => {
    if (height === undefined || height === previous.rowHeights?.[index]) return;
    model.setRowsHeight(SHEET, FIRST + index, FIRST + index, height);
  });
}

/**
 * Styles go down as one rectangle because `onPasteStyles` works on the
 * selection, so per-cell application would mean moving the selection once per
 * cell. The local selection is saved and put back around it.
 */
function applyStyles(model: Model, cells: TableCell[][], width: number): void {
  const base = baseStyle() as unknown as Json;
  const grid = cells.map((row) =>
    Array.from({ length: width }, (_, column) => {
      const style = row[column]?.style;
      return (style ? mergeStyle(base, style) : base) as unknown as CellStyle;
    }),
  );
  model.setSelectedCell(FIRST, FIRST);
  model.setSelectedRange(FIRST, FIRST, FIRST + cells.length - 1, FIRST + width - 1);
  model.onPasteStyles(grid);
}

/** Writes `next` into `model`, touching only the cells that actually differ. */
export function applyRemoteSheet(
  model: Model,
  next: { cells: TableCell[][]; layout: TableLayout },
): void {
  const previous = readSheet(model);
  const selected = model.getSelectedView();
  const [rangeRowStart, rangeColumnStart, rangeRowEnd, rangeColumnEnd] = selected.range;

  const height = next.cells.length;
  const width = gridWidth(next.cells);
  const previousHeight = previous.cells.length;
  const previousWidth = gridWidth(previous.cells);

  // Whatever the new grid no longer covers has to go, or a shrunk sheet keeps
  // reporting the old extent and the removed cells come straight back.
  if (previousHeight > height && previousWidth > 0) {
    model.rangeClearAll(
      SHEET,
      FIRST + height,
      FIRST,
      FIRST + previousHeight - 1,
      FIRST + Math.max(previousWidth, width) - 1,
    );
  }
  if (previousWidth > width && previousHeight > 0) {
    model.rangeClearAll(
      SHEET,
      FIRST,
      FIRST + width,
      FIRST + previousHeight - 1,
      FIRST + previousWidth - 1,
    );
  }

  let restyled = false;
  for (let row = 0; row < height; row++) {
    const line = next.cells[row] as TableCell[];
    const previousLine = previous.cells[row];
    for (let column = 0; column < width; column++) {
      const cell = line[column];
      const previousCell = previousLine?.[column];
      const value = input(cell) ?? "";
      if (value !== (input(previousCell) ?? "")) {
        model.setUserInput(SHEET, FIRST + row, FIRST + column, value);
      }
      if (!sameStyle(cell, previousCell)) restyled = true;
    }
  }

  if (restyled && height > 0 && width > 0) applyStyles(model, next.cells, width);
  applyLayout(model, next.layout, previous.layout);
  model.evaluate();

  // IronCalc requires the active cell to be a corner of the range, so it goes
  // back first (see `SpreadsheetTableView.rebuild`).
  model.setSelectedCell(selected.row, selected.column);
  model.setSelectedRange(rangeRowStart, rangeColumnStart, rangeRowEnd, rangeColumnEnd);
}
