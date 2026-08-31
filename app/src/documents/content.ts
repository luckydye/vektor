import { marked } from "marked";
import { rowsToHtmlTable } from "#documents/htmlTable.ts";
import { sanitizeDocumentHtml } from "#utils/html.ts";
import { parseCsvRows } from "#utils/xlsx.ts";

// Custom renderer so task lists produce TipTap-compatible markup:
//   <ul data-type="taskList">
//   <li data-type="taskItem" data-checked="true/false"><p>text</p></li>
// Plain list items within a task list are also wrapped in <p> so TipTap
// can parse them (its TaskItem schema requires 'paragraph block*' content).
function wrapInParagraph(content: string): string {
  if (/^<(p|ul|ol|h[1-6]|blockquote|pre|div)\b/.test(content)) return content;
  const blockStart = content.search(/<(ul|ol|p|h[1-6]|blockquote|pre|div)\b/);
  if (blockStart > 0)
    return `<p>${content.slice(0, blockStart).trimEnd()}</p>${content.slice(blockStart)}`;
  return `<p>${content.trimEnd()}</p>`;
}

marked.use({
  renderer: {
    listitem(token) {
      const inner = (this as { parser: { parse(t: unknown): string } }).parser.parse(
        token.tokens,
      );
      const content = inner.replace(/<input\b[^>]*disabled=""[^>]*>\s*/g, "");
      if (token.task) {
        const checked = token.checked ? "true" : "false";
        const checkedAttr = token.checked ? ' checked=""' : "";
        return `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"${checkedAttr}><span></span></label><div>${wrapInParagraph(content)}</div></li>`;
      }
      return `<li>${wrapInParagraph(content)}</li>`;
    },
    list(token) {
      const isTaskList = !token.ordered && token.items.some((i) => i.task);
      if (!isTaskList) return false;
      // All items in a task list become taskItems — plain items get data-checked="false".
      // Mixed lists with plain <li> inside a taskList cause TipTap to split on save.
      const parser = (this as { parser: { parse(t: unknown): string } }).parser;
      const body = token.items
        .map((item) => {
          const inner = parser.parse(item.tokens);
          const content = inner.replace(/<input\b[^>]*disabled=""[^>]*>\s*/g, "");
          const checked = item.checked ? "true" : "false";
          const checkedAttr = item.checked ? ' checked=""' : "";
          return `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"${checkedAttr}><span></span></label><div>${wrapInParagraph(content)}</div></li>`;
        })
        .join("");
      return `<ul data-type="taskList">${body}</ul>\n`;
    },
  },
});

const MARKDOWN_TYPES = new Set([
  "text/markdown",
  "text/x-markdown",
  "application/markdown",
  "application/x-markdown",
]);

export const CSV_TYPES: readonly string[] = [
  "text/csv",
  "application/csv",
  "text/x-csv",
  "application/vnd.ms-excel",
] as const;
const CSV_TYPE_SET = new Set<string>(CSV_TYPES);
const APP_TYPES = new Set<string>(["application/vnd.wiki.app+html"]);

export function getDocumentTypeForContentType(
  contentType: string | null,
): string | undefined {
  const mimeType = getMimeType(contentType);
  if (!mimeType) return undefined;
  if (CSV_TYPE_SET.has(mimeType)) return "document";
  if (APP_TYPES.has(mimeType)) return "app";
  if (mimeType === "text/html" || MARKDOWN_TYPES.has(mimeType)) return "document";
  return undefined;
}

export function getMimeType(contentType: string | null): string | null {
  if (!contentType) return null;
  return contentType.split(";")[0]?.trim().toLowerCase() || null;
}

function isBlankRow(row: string[]): boolean {
  return row.length === 1 && row[0] === "";
}

function csvToHtmlTable(content: string): string {
  const rows = parseCsvRows(content);
  while (rows.length > 0 && isBlankRow(rows[rows.length - 1] as string[])) rows.pop();
  return rowsToHtmlTable(rows);
}

/**
 * Whether `content` is CSV text that needs converting to rich-text table markup.
 */
function isCsvContent(contentType: string | null): boolean {
  const mimeType = getMimeType(contentType);
  return Boolean(mimeType && CSV_TYPE_SET.has(mimeType));
}

/** Converts CSV or Markdown when requested, then sanitizes the submitted HTML. */
export function prepareDocumentContent(
  content: string,
  contentType: string | null,
): string {
  if (isCsvContent(contentType)) {
    return sanitizeDocumentHtml(csvToHtmlTable(content));
  }

  const mimeType = getMimeType(contentType);
  const markdown = MARKDOWN_TYPES.has(mimeType ?? "");

  let prepared = content;
  if (markdown) {
    prepared = marked.parse(content, { breaks: true, gfm: true }) as string;
  }

  return sanitizeDocumentHtml(prepared);
}
