/**
 * The `<table>` markup that `csv` documents store in their `content` column,
 * in both directions.
 *
 * A CSV upload is converted to a table on the way in (`#documents/content.ts`),
 * and that table is the only copy — the original file is not kept. So this is
 * the document's real storage format, and everything that reads a csv document
 * goes through here: the spreadsheet UI loading and saving it, and the agent's
 * `html-to-csv` command.
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

/** Rows of the first `<table>` in `html`, or null when there is none. */
export function htmlTableToCells(
  html: string,
  options: ReadOptions = {},
): TableCell[][] | null {
  const table = findFirstTag(parseHtml(html), "table");
  if (!table) return null;

  const rows = (table.body ?? []).flatMap((child) => {
    if (isTag(child, "thead") || isTag(child, "tbody") || isTag(child, "tfoot")) {
      return childTags(child, ["tr"]);
    }
    return isTag(child, "tr") ? [child] : [];
  });

  return rows.map((row) =>
    childTags(row, ["th", "td"]).map((cell) => {
      let value = decodeEntities(nodeText(cell));
      if (options.collapseWhitespace) value = value.replace(/\s+/g, " ").trim();
      const source = attributeValue(cell, "data-source");
      return source === undefined ? { value } : { value, source: decodeEntities(source) };
    }),
  );
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
  const attributes =
    cell.source === undefined ? "" : ` data-source="${escapeHtml(cell.source)}"`;
  return `<${tag}${attributes}>${escapeHtml(cell.value)}</${tag}>`;
}

/**
 * Rows as the stored table markup: the first row is the header, the rest the
 * body. Empty input still produces a table, so a csv document always has one
 * for readers to find.
 */
export function cellsToHtmlTable(rows: TableCell[][]): string {
  const [header, ...body] = rows;
  if (!header) return "<table><tbody></tbody></table>";

  const thead = `<thead><tr>${header.map((cell) => cellHtml("th", cell)).join("")}</tr></thead>`;
  const tbody = `<tbody>${body
    .map((row) => `<tr>${row.map((cell) => cellHtml("td", cell)).join("")}</tr>`)
    .join("")}</tbody>`;

  return `<table>${thead}${tbody}</table>`;
}

/** `cellsToHtmlTable` for plain text rows, with no formulas to carry. */
export function rowsToHtmlTable(rows: string[][]): string {
  return cellsToHtmlTable(rows.map((row) => row.map((value) => ({ value }))));
}
