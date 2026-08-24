import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import {
  cellsToHtmlTable,
  type TableCell,
  type TableLayout,
} from "#documents/htmlTable.ts";

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
      ...(columnWidths.some((width) => width !== undefined)
        ? { columnWidths }
        : {}),
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
      const type = existingCell?.type === headerType || (headerRow && rowIndex === 0)
        ? headerType
        : cellType;
      const columnWidth = data.layout.columnWidths?.[column];
      return type.create(
        {
          ...(existingCell?.attrs ?? type.defaultAttrs ?? {}),
          colspan: 1,
          rowspan: 1,
          colwidth:
            columnWidth === undefined
              ? (existingCell?.attrs.colwidth ?? type.defaultAttrs?.colwidth)
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
        ...(existingRow?.attrs ?? rowType.defaultAttrs ?? {}),
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
      if (!paragraph || paragraph.type.name !== "paragraph") {
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
    rows.push(
      row.type.create(
        { ...row.attrs, dataHeight: null },
        cells,
        row.marks,
      ),
    );
  });
  return current.type.create(
    { ...current.attrs, tableKind: null },
    rows,
    current.marks,
  );
}
