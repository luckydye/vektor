/**
 * Keeps an IronCalc model and a collaborative document in step.
 *
 * The room is the source of truth. A local edit is published by diffing the
 * model's used extent against the document and writing only what differs; a
 * remote edit is applied into the model cell by cell. Because publishing is a
 * diff rather than a replay, applying a remote change cannot echo back — once
 * the model matches the document there is nothing left to publish.
 *
 * The engine has its own diff channel (`flushSendQueue`/`applyExternalDiffs`),
 * which is not used here: it is an operation log with no causality information,
 * so it converges only under a strict total order. The document is a CRDT and
 * converges on its own, which is what the rest of the app already relies on.
 */

import type { Model } from "@ironcalc/wasm";
// biome-ignore lint/suspicious/noExplicitAny: `observeDeep` is typed with `YEvent<any>[]`; narrowing it here would not type-check against yjs.
import * as Y from "yjs";
import type { TableCell, TableLayout } from "#documents/htmlTable.ts";
import { readSheet } from "#spreadsheet/csvDocument.ts";
import {
  readCell,
  rowHeight,
  rowWidth,
  type SheetCell,
  setRowHeight,
  sheetColumns,
  sheetRows,
} from "#spreadsheet/sheetDoc.ts";

/** Marks transactions this module produced, so its own observer skips them. */
const LOCAL_ORIGIN = "spreadsheet-local";

const SHEET = 0;
const FIRST = 1;

interface Options {
  doc: Y.Doc;
  model: Model;
  /** A remote change landed in the model; repaint. */
  onRemoteChange: () => void;
}

function sameCell(cell: TableCell, stored: SheetCell | undefined): boolean {
  if (!stored) {
    return cell.value === "" && cell.source === undefined && cell.style === undefined;
  }
  return (
    cell.value === stored.v &&
    cell.source === stored.i &&
    JSON.stringify(cell.style) === JSON.stringify(stored.s)
  );
}

function toStored(cell: TableCell): SheetCell | undefined {
  if (cell.value === "" && cell.source === undefined && cell.style === undefined) {
    return undefined;
  }
  return {
    v: cell.value,
    ...(cell.source === undefined ? {} : { i: cell.source }),
    ...(cell.style === undefined ? {} : { s: cell.style }),
  };
}

/**
 * Walks a style difference into the engine's `path`/`value` pairs —
 * `{font:{b:true}}` becomes `updateRangeStyle(area, "font.b", "true")`.
 */
function applyStyle(
  model: Model,
  row: number,
  column: number,
  style: Record<string, unknown> | undefined,
): void {
  // Whatever was there before is not necessarily a subset of what is coming, so
  // the cell starts clean rather than accumulating the two.
  model.rangeClearFormatting(SHEET, row, column, row, column);
  if (!style) return;

  const area = { sheet: SHEET, row, column, width: 1, height: 1 };
  const walk = (value: unknown, path: string[]): void => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [key, nested] of Object.entries(value)) walk(nested, [...path, key]);
      return;
    }
    model.updateRangeStyle(area, path.join("."), String(value));
  };
  walk(style, []);
}

export function connectSheet(options: Options): {
  publish: () => void;
  dispose: () => void;
} {
  const { doc, model } = options;
  const rows = sheetRows(doc);
  const columns = sheetColumns(doc);

  /** Writes the model's current grid into the document, differences only. */
  const publish = () => {
    const { cells, layout } = readSheet(model);
    doc.transact(() => {
      // Rows the model no longer has.
      if (rows.length > cells.length) {
        rows.delete(cells.length, rows.length - cells.length);
      }
      cells.forEach((line, rowIndex) => {
        let row = rows.get(rowIndex);
        if (!row) {
          row = new Y.Map<unknown>();
          rows.insert(rowIndex, [row]);
        }
        const width = Math.max(line.length, rowWidth(row));
        for (let column = 0; column < width; column++) {
          const cell = line[column] ?? { value: "" };
          const stored = readCell(row, column);
          if (sameCell(cell, stored)) continue;
          const next = toStored(cell);
          if (next) row.set(String(column), next);
          else row.delete(String(column));
        }
        const height = layout.rowHeights?.[rowIndex];
        if (height !== rowHeight(row)) setRowHeight(row, height);
      });

      layout.columnWidths?.forEach((width, column) => {
        const key = String(column);
        if (width === columns.get(key)) return;
        if (width === undefined) columns.delete(key);
        else columns.set(key, width);
      });
    }, LOCAL_ORIGIN);
  };

  /** Writes one document cell into the model. */
  const applyCell = (rowIndex: number, column: number, cell: SheetCell | undefined) => {
    const row = FIRST + rowIndex;
    const target = FIRST + column;
    model.setUserInput(SHEET, row, target, cell?.i ?? cell?.v ?? "");
    applyStyle(model, row, target, cell?.s);
  };

  const onUpdate = (events: Y.YEvent<any>[], transaction: Y.Transaction) => {
    if (transaction.origin === LOCAL_ORIGIN) return;

    // Evaluation is paused for the batch: every changed cell would otherwise
    // trigger a recalculation of the whole sheet.
    model.pauseEvaluation();
    try {
      for (const event of events) {
        if (event.target === rows) {
          // Rows were added or removed, so every index below the change now
          // means a different row: the simple thing that is always right is to
          // rewrite the grid.
          rewriteFromDoc();
          break;
        }
        if (event.target === columns) {
          for (const key of event.changes.keys.keys()) {
            const column = Number.parseInt(key, 10);
            const width = columns.get(key);
            if (Number.isInteger(column) && width !== undefined) {
              model.setColumnsWidth(SHEET, FIRST + column, FIRST + column, width);
            }
          }
          continue;
        }
        const rowIndex = rows.toArray().indexOf(event.target as Y.Map<unknown>);
        if (rowIndex < 0) continue;
        const row = rows.get(rowIndex) as Y.Map<unknown>;
        for (const key of event.changes.keys.keys()) {
          if (key === "h") {
            const height = rowHeight(row);
            if (height !== undefined) {
              model.setRowsHeight(SHEET, FIRST + rowIndex, FIRST + rowIndex, height);
            }
            continue;
          }
          const column = Number.parseInt(key, 10);
          if (Number.isInteger(column))
            applyCell(rowIndex, column, readCell(row, column));
        }
      }
    } finally {
      model.resumeEvaluation();
      model.evaluate();
    }
    options.onRemoteChange();
  };

  /** Replaces the model's grid with the document's, wholesale. */
  const rewriteFromDoc = () => {
    const width = rows
      .toArray()
      .reduce((widest, row) => Math.max(widest, rowWidth(row)), 0);
    // What the model had is cleared first, so rows removed remotely do not
    // linger below the new last row.
    const previous = readSheet(model);
    const clearRows = Math.max(previous.cells.length, rows.length);
    const clearColumns = Math.max(previous.cells[0]?.length ?? 0, width);
    if (clearRows > 0 && clearColumns > 0) {
      model.rangeClearAll(SHEET, FIRST, FIRST, FIRST + clearRows, FIRST + clearColumns);
    }
    rows.forEach((row, rowIndex) => {
      for (let column = 0; column < width; column++) {
        applyCell(rowIndex, column, readCell(row, column));
      }
      const height = rowHeight(row);
      if (height !== undefined) {
        model.setRowsHeight(SHEET, FIRST + rowIndex, FIRST + rowIndex, height);
      }
    });
  };

  rows.observeDeep(onUpdate);
  columns.observeDeep(onUpdate);

  return {
    publish,
    dispose: () => {
      rows.unobserveDeep(onUpdate);
      columns.unobserveDeep(onUpdate);
    },
  };
}
