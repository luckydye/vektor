/**
 * Conversion between rich-text `<table>` markup and spreadsheet cell data.
 *
 * A CSV upload is converted to a table on the way in (`#documents/content.ts`),
 * and that table is the only copy — the original file is not kept. Embedded
 * spreadsheet tables and the agent's `html-to-csv` command use the same shape.
 *
 * A cell holds its displayed value. When the value was computed from something
 * else — a formula, or an input the engine typed differently from how it prints
 * it — the raw input is kept alongside in `data-source`. That way the grid
 * reloads a cell exactly as the user left it, while search, exports and the
 * agent go on reading the value.
 *
 *     <td data-source="=SUM(A1:A2)">42</td>
 *     <td data-source="'0012">0012</td>
 *     <td>42</td>
 */

import {
  escapeHtml,
  type HtmlNode,
  type HtmlTagNode,
  parseHtml,
  SyntaxKind,
} from "#utils/html.ts";

export interface TableCell {
  /** What the cell displays, and the only thing non-spreadsheet readers see. */
  value: string;
  /** The raw input behind it, when that is not the value itself. */
  source?: string;
  /**
   * How the cell is formatted, as the difference from the spreadsheet's default
   * style — `{"font":{"b":true}}` and the like. Only the difference, because the
   * full style is ~130 bytes of mostly defaults and there is one per cell.
   * Opaque here; `#spreadsheet/spreadsheetModel.ts` gives it meaning.
   */
  style?: Record<string, unknown>;
}

/** Sizes the grid does not derive from its contents. */
export interface TableLayout {
  /** Column widths in px by column index; `undefined` leaves the default. */
  columnWidths?: (number | undefined)[];
  /** Row heights in px by row index; `undefined` leaves the default. */
  rowHeights?: (number | undefined)[];
}

function isTag(node: HtmlNode, name?: string): node is HtmlTagNode {
  return node.type === SyntaxKind.Tag && (name ? node.name.toLowerCase() === name : true);
}

function nodeText(node: HtmlNode): string {
  if (node.type === SyntaxKind.Text) return node.value;
  if (!isTag(node) || !node.body) return "";
  return node.body.map(nodeText).join("");
}

/**
 * Reverses `escapeHtml`, plus `&nbsp;`. `&amp;` is decoded last so that an
 * escaped entity (`&amp;lt;`) comes back as text (`&lt;`) rather than as the
 * character it names.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function attributeValue(tag: HtmlTagNode, name: string): string | undefined {
  for (const attribute of tag.attributes ?? []) {
    if (attribute.name.value.toLowerCase() === name) {
      return attribute.value?.value;
    }
  }
  return undefined;
}

function findFirstTag(nodes: HtmlNode[], name: string): HtmlTagNode | null {
  for (const node of nodes) {
    if (!isTag(node)) continue;
    if (node.name.toLowerCase() === name) return node;
    if (node.body) {
      const nested = findFirstTag(node.body, name);
      if (nested) return nested;
    }
  }
  return null;
}

function childTags(node: HtmlTagNode, names: string[]): HtmlTagNode[] {
  const allowed = new Set(names);
  const result: HtmlTagNode[] = [];
  for (const child of node.body ?? []) {
    if (isTag(child) && allowed.has(child.name.toLowerCase())) result.push(child);
  }
  return result;
}

interface ReadOptions {
  /**
   * Collapse runs of whitespace and trim each cell. For prose-shaped tables
   * pasted in from elsewhere, where the markup's own indentation would
   * otherwise become cell content. Off by default, so a cell that legitimately
   * holds newlines or double spaces survives a round-trip.
   */
  collapseWhitespace?: boolean;
}

function parsePixels(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** A stored attribute that should hold JSON. Bad JSON is ignored, not thrown. */
function parseJsonAttribute(
  value: string | undefined,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(decodeEntities(value));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The first `<table>` in `html`, cells and sizes, or null when there is none. */
export function htmlTableToTable(
  html: string,
  options: ReadOptions = {},
): { cells: TableCell[][]; layout: TableLayout } | null {
  const table = findFirstTag(parseHtml(html), "table");
  if (!table) return null;

  const rowTags = (table.body ?? []).flatMap((child) => {
    if (isTag(child, "thead") || isTag(child, "tbody") || isTag(child, "tfoot")) {
      return childTags(child, ["tr"]);
    }
    return isTag(child, "tr") ? [child] : [];
  });

  const cells = rowTags.map((row) =>
    childTags(row, ["th", "td"]).map((cell) => {
      let value = decodeEntities(nodeText(cell));
      if (options.collapseWhitespace) value = value.replace(/\s+/g, " ").trim();
      const source = attributeValue(cell, "data-source");
      const style = parseJsonAttribute(attributeValue(cell, "data-style"));
      return {
        value,
        ...(source === undefined ? {} : { source: decodeEntities(source) }),
        ...(style === undefined ? {} : { style }),
      };
    }),
  );

  const colgroup = findFirstTag(table.body ?? [], "colgroup");
  const columnWidths = colgroup
    ? childTags(colgroup, ["col"]).map((col) =>
        parsePixels(attributeValue(col, "data-width")),
      )
    : undefined;
  const rowHeights = rowTags.map((row) =>
    parsePixels(attributeValue(row, "data-height")),
  );

  return {
    cells,
    layout: {
      ...(columnWidths?.some((width) => width !== undefined) ? { columnWidths } : {}),
      ...(rowHeights.some((height) => height !== undefined) ? { rowHeights } : {}),
    },
  };
}

/** Rows of the first `<table>` in `html`, or null when there is none. */
export function htmlTableToCells(
  html: string,
  options: ReadOptions = {},
): TableCell[][] | null {
  return htmlTableToTable(html, options)?.cells ?? null;
}

function escapeCsvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The first `<table>` in `html` as CSV text, or null when there is none.
 * Cells contribute their value — a CSV has nowhere to put the input behind it.
 */
export function htmlTableToCsv(html: string, options: ReadOptions = {}): string | null {
  const rows = htmlTableToCells(html, options);
  if (!rows) return null;
  return rows
    .map((row) => row.map((cell) => escapeCsvCell(cell.value)).join(","))
    .join("\n");
}

function cellHtml(tag: "th" | "td", cell: TableCell): string {
  let attributes = "";
  if (cell.source !== undefined) {
    attributes += ` data-source="${escapeHtml(cell.source)}"`;
  }
  if (cell.style !== undefined && Object.keys(cell.style).length > 0) {
    attributes += ` data-style="${escapeHtml(JSON.stringify(cell.style))}"`;
  }
  return `<${tag}${attributes}>${escapeHtml(cell.value)}</${tag}>`;
}

function rowHtml(
  tag: "th" | "td",
  cells: TableCell[],
  height: number | undefined,
): string {
  const attributes = height === undefined ? "" : ` data-height="${Math.round(height)}"`;
  return `<tr${attributes}>${cells.map((cell) => cellHtml(tag, cell)).join("")}</tr>`;
}

/**
 * Rows as the stored table markup: the first row is the header, the rest the
 * body. Empty input still produces a valid empty table.
 */
export function cellsToHtmlTable(rows: TableCell[][], layout: TableLayout = {}): string {
  const [header, ...body] = rows;
  if (!header) return "<table><tbody></tbody></table>";

  // Only when a width was actually set — an empty colgroup is noise, and every
  // non-spreadsheet reader has to step over it.
  const widths = layout.columnWidths;
  const colgroup = widths?.some((width) => width !== undefined)
    ? `<colgroup>${header
        .map((_, index) => {
          const width = widths[index];
          return width === undefined
            ? "<col>"
            : `<col data-width="${Math.round(width)}">`;
        })
        .join("")}</colgroup>`
    : "";

  const heights = layout.rowHeights ?? [];
  const thead = `<thead>${rowHtml("th", header, heights[0])}</thead>`;
  const tbody = `<tbody>${body
    .map((row, index) => rowHtml("td", row, heights[index + 1]))
    .join("")}</tbody>`;

  return `<table>${colgroup}${thead}${tbody}</table>`;
}

/** `cellsToHtmlTable` for plain text rows, with no formulas to carry. */
export function rowsToHtmlTable(rows: string[][]): string {
  return cellsToHtmlTable(rows.map((row) => row.map((value) => ({ value }))));
}
