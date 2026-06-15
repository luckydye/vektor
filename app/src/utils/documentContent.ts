import { marked } from "marked";

// Custom renderer so task lists produce TipTap-compatible markup:
//   <ul data-type="taskList">
//   <li data-type="taskItem" data-checked="true/false"><p>text</p></li>
// Plain list items within a task list are also wrapped in <p> so TipTap
// can parse them (its TaskItem schema requires 'paragraph block*' content).
function wrapInParagraph(content: string): string {
  if (/^<(p|ul|ol|h[1-6]|blockquote|pre|div)\b/.test(content)) return content;
  const blockStart = content.search(/<(ul|ol|p|h[1-6]|blockquote|pre|div)\b/);
  if (blockStart > 0) return `<p>${content.slice(0, blockStart).trimEnd()}</p>${content.slice(blockStart)}`;
  return `<p>${content.trimEnd()}</p>`;
}

marked.use({
  renderer: {
    listitem(token) {
      const inner = (this as { parser: { parse(t: unknown): string } }).parser.parse(token.tokens);
      const content = inner.replace(/<input\b[^>]*type="checkbox"[^>]*>\s*/g, "");
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
          const content = inner.replace(/<input\b[^>]*type="checkbox"[^>]*>\s*/g, "");
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
  if (CSV_TYPE_SET.has(mimeType)) return "csv";
  if (APP_TYPES.has(mimeType)) return "app";
  if (mimeType === "text/html" || MARKDOWN_TYPES.has(mimeType)) return "document";
  return undefined;
}

export function getMimeType(contentType: string | null): string | null {
  if (!contentType) return null;
  return contentType.split(";")[0]?.trim().toLowerCase() || null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };

  const pushRow = () => {
    // Ignore trailing empty rows.
    if (row.length === 1 && row[0] === "") {
      row = [];
      return;
    }
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      pushField();
      continue;
    }

    if (char === "\r") {
      pushField();
      pushRow();
      if (content[i + 1] === "\n") i++;
      continue;
    }

    if (char === "\n") {
      pushField();
      pushRow();
      continue;
    }

    field += char;
  }

  pushField();
  if (row.length > 1 || row[0] !== "") {
    pushRow();
  }

  return rows;
}

function csvToHtmlTable(content: string): string {
  const rows = parseCsv(content);
  if (rows.length === 0) {
    return "<table><tbody></tbody></table>";
  }

  const [header, ...dataRows] = rows;

  const thead = `<thead><tr>${header
    .map((cell) => `<th>${escapeHtml(cell)}</th>`)
    .join("")}</tr></thead>`;
  const tbody = `<tbody>${dataRows
    .map(
      (cells) =>
        `<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody>`;

  return `<table>${thead}${tbody}</table>`;
}

function isCsvContent(contentType: string | null, documentType?: string | null): boolean {
  if (typeof documentType === "string" && documentType.toLowerCase() === "csv") {
    return true;
  }
  const mimeType = getMimeType(contentType);
  return CSV_TYPE_SET.has(mimeType ?? "");
}

export function toHtmlIfMarkdown(
  content: string,
  contentType: string | null,
  documentType?: string | null,
): string {
  if (isCsvContent(contentType, documentType)) {
    return csvToHtmlTable(content);
  }

  const mimeType = getMimeType(contentType);
  if (!MARKDOWN_TYPES.has(mimeType ?? "") && documentType !== "markdown") {
    return content;
  }
  return marked.parse(content, { breaks: true, gfm: true }) as string;
}
