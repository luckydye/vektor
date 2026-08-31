import type { Attrs, Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import {
  cellsToHtmlTable,
  type TableCell,
  type TableLayout,
} from "@vektorapp/spreadsheet/table";

export const SPREADSHEET_TABLE_KIND = "spreadsheet";

export interface SpreadsheetTableData {
  cells: TableCell[][];
  layout: TableLayout;
}

export function isSpreadsheetTable(node: ProseMirrorNode): boolean {
  return node.type.name === "table" && node.attrs.tableKind === SPREADSHEET_TABLE_KIND;
}

export function spreadsheetTableData(node: ProseMirrorNode): SpreadsheetTableData {
  const cells: TableCell[][] = [];
  const rowHeights: (number | undefined)[] = [];

  node.forEach((row) => {
    const line: TableCell[] = [];
    row.forEach((cell) => {
      const source = cell.attrs.dataSource;
      const storedStyle = cell.attrs.dataStyle;
      const style =
        storedStyle && typeof storedStyle === "object" && !Array.isArray(storedStyle)
          ? (storedStyle as Record<string, unknown>)
          : typeof cell.attrs.backgroundColor === "string"
            ? { fill: { color: cell.attrs.backgroundColor } }
            : undefined;
      line.push({
        value: cell.textContent,
        ...(typeof source === "string" ? { source } : {}),
        ...(style ? { style } : {}),
      });
    });
    cells.push(line);
    const height = row.attrs.dataHeight;
    rowHeights.push(typeof height === "number" ? height : undefined);
  });

  const firstRow = node.firstChild;
  const columnWidths = firstRow
    ? Array.from({ length: firstRow.childCount }, (_, column) => {
        const widths = firstRow.child(column).attrs.colwidth;
        const width = Array.isArray(widths) ? widths[0] : undefined;
        return typeof width === "number" ? width : undefined;
      })
    : [];

  return {
    cells,
    layout: {
      ...(columnWidths.some((width) => width !== undefined) ? { columnWidths } : {}),
      ...(rowHeights.some((height) => height !== undefined) ? { rowHeights } : {}),
    },
  };
}

export function spreadsheetTableHtml(node: ProseMirrorNode): string {
  const { cells, layout } = spreadsheetTableData(node);
  return cellsToHtmlTable(cells, layout);
}

export function spreadsheetTableFingerprint(node: ProseMirrorNode): string {
  return JSON.stringify(spreadsheetTableData(node));
}

function childAt(node: ProseMirrorNode | null | undefined, index: number) {
  return node && index >= 0 && index < node.childCount ? node.child(index) : null;
}

function textParagraph(schema: Schema, value: string): ProseMirrorNode {
  const paragraph = schema.nodes.paragraph;
  if (!paragraph) throw new Error("Spreadsheet tables require paragraph nodes");
  return paragraph.create(null, value ? schema.text(value) : undefined);
}

/**
 * Projects the engine's dense grid back into the document table node.
 *
 * Spreadsheet cells deliberately contain a single plain paragraph. The source
 * input and engine formatting live on the cell attributes so read mode can show
 * the computed paragraph without loading the engine.
 */
export function spreadsheetTableNodeFromData(
  current: ProseMirrorNode,
  schema: Schema,
  data: SpreadsheetTableData,
): ProseMirrorNode {
  const rowType = schema.nodes.tableRow;
  const cellType = schema.nodes.tableCell;
  const headerType = schema.nodes.tableHeader;
  if (!rowType || !cellType || !headerType) {
    throw new Error("Spreadsheet tables require the document table schema");
  }

  const existingFirstRow = current.firstChild;
  const headerRow =
    !!existingFirstRow &&
    existingFirstRow.childCount > 0 &&
    Array.from({ length: existingFirstRow.childCount }).every(
      (_, column) => existingFirstRow.child(column).type === headerType,
    );

  const sourceCells = data.cells.length > 0 ? data.cells : [[{ value: "" }]];
  const width = Math.max(
    1,
    sourceCells.reduce((widest, row) => Math.max(widest, row.length), 0),
  );
  const rows = sourceCells.map((line, rowIndex) => {
    const existingRow = childAt(current, rowIndex);
    const cells = Array.from({ length: width }, (_, column) => {
      const value = line[column] ?? { value: "" };
      const existingCell = childAt(existingRow, column);
      const type =
        existingCell?.type === headerType || (headerRow && rowIndex === 0)
          ? headerType
          : cellType;
      const columnWidth = data.layout.columnWidths?.[column];
      return type.create(
        {
          ...(existingCell?.attrs ?? {}),
          colspan: 1,
          rowspan: 1,
          colwidth:
            columnWidth === undefined
              ? (existingCell?.attrs.colwidth ?? null)
              : [Math.round(columnWidth)],
          dataSource: value.source ?? null,
          dataStyle: value.style ?? null,
          ...(type === cellType ? { backgroundColor: null } : {}),
        },
        textParagraph(schema, value.value),
      );
    });
    return rowType.create(
      {
        ...(existingRow?.attrs ?? {}),
        dataHeight: data.layout.rowHeights?.[rowIndex] ?? null,
      },
      cells,
    );
  });

  return current.type.create(
    { ...current.attrs, tableKind: SPREADSHEET_TABLE_KIND },
    rows,
  );
}

/** Whether conversion can preserve the table without flattening rich content. */
export function canConvertToSpreadsheet(node: ProseMirrorNode): boolean {
  if (node.type.name !== "table") return false;
  let compatible = true;
  node.forEach((row) => {
    row.forEach((cell) => {
      if (cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1 || cell.childCount !== 1) {
        compatible = false;
        return;
      }
      const paragraph = cell.firstChild;
      if (paragraph?.type.name !== "paragraph") {
        compatible = false;
        return;
      }
      paragraph.forEach((inline) => {
        if (!inline.isText || inline.marks.length > 0) compatible = false;
      });
    });
  });
  return compatible;
}

/** Flattens formulas to their displayed paragraphs and restores normal table editing. */
export function normalTableNodeFromSpreadsheet(
  current: ProseMirrorNode,
): ProseMirrorNode {
  const rows: ProseMirrorNode[] = [];
  current.forEach((row) => {
    const cells: ProseMirrorNode[] = [];
    row.forEach((cell) => {
      const style = cell.attrs.dataStyle;
      const backgroundColor =
        style &&
        typeof style === "object" &&
        !Array.isArray(style) &&
        typeof (style as { fill?: { color?: unknown } }).fill?.color === "string"
          ? (style as { fill: { color: string } }).fill.color
          : cell.attrs.backgroundColor;
      cells.push(
        cell.type.create(
          {
            ...cell.attrs,
            dataSource: null,
            dataStyle: null,
            ...(cell.type.name === "tableCell" ? { backgroundColor } : {}),
          },
          cell.content,
          cell.marks,
        ),
      );
    });
    rows.push(row.type.create({ ...row.attrs, dataHeight: null }, cells, row.marks));
  });
  return current.type.create({ ...current.attrs, tableKind: null }, rows, current.marks);
}

function sameAttrs(a: Attrs, b: Attrs): boolean {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] === b[key]) continue;
    if (JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null)) return false;
  }
  return true;
}

/**
 * Rewrites the table at `pos` into `next` with one step per changed cell.
 *
 * Replacing the whole node instead leaves y-prosemirror without a mapping for
 * any cell, so a single-cell edit syncs as a replacement of the entire table
 * and concurrent edits to different cells overwrite each other. Returns false
 * when rows or columns were added or removed, which only a full replace can
 * express; `tr` is left untouched in that case.
 */
export function applySpreadsheetTableDiff(
  tr: Transaction,
  pos: number,
  current: ProseMirrorNode,
  next: ProseMirrorNode,
): boolean {
  if (current.childCount !== next.childCount) return false;

  const rows: { rowPos: number; cellOffsets: number[] }[] = [];
  let rowOffset = 0;
  for (let index = 0; index < current.childCount; index++) {
    const row = current.child(index);
    const nextRow = next.child(index);
    if (row.type !== nextRow.type || row.childCount !== nextRow.childCount) return false;
    const cellOffsets: number[] = [];
    let cellOffset = 0;
    for (let column = 0; column < row.childCount; column++) {
      if (row.child(column).type !== nextRow.child(column).type) return false;
      cellOffsets.push(cellOffset);
      cellOffset += row.child(column).nodeSize;
    }
    rows.push({ rowPos: pos + 1 + rowOffset, cellOffsets });
    rowOffset += row.nodeSize;
  }

  // Descending, so a content replace never shifts a position not yet visited.
  for (let index = rows.length - 1; index >= 0; index--) {
    const { rowPos, cellOffsets } = rows[index] as (typeof rows)[number];
    const row = current.child(index);
    const nextRow = next.child(index);
    for (let column = row.childCount - 1; column >= 0; column--) {
      const cell = row.child(column);
      const nextCell = nextRow.child(column);
      const cellPos = rowPos + 1 + (cellOffsets[column] as number);
      if (!cell.content.eq(nextCell.content)) {
        tr.replaceWith(cellPos + 1, cellPos + 1 + cell.content.size, nextCell.content);
      }
      if (!sameAttrs(cell.attrs, nextCell.attrs)) {
        tr.setNodeMarkup(cellPos, undefined, nextCell.attrs, nextCell.marks);
      }
    }
    if (!sameAttrs(row.attrs, nextRow.attrs)) {
      tr.setNodeMarkup(rowPos, undefined, nextRow.attrs, nextRow.marks);
    }
  }
  if (!sameAttrs(current.attrs, next.attrs)) {
    tr.setNodeMarkup(pos, undefined, next.attrs, next.marks);
  }
  return true;
}
