import { marked } from "marked";

const MARKDOWN_TYPES = new Set([
  "text/markdown",
  "text/x-markdown",
  "application/markdown",
  "application/x-markdown",
]);

export function getMimeType(contentType: string | null): string | null {
  if (!contentType) return null;
  return contentType.split(";")[0]?.trim().toLowerCase() || null;
}

export function toHtmlIfMarkdown(content: string, contentType: string | null): string {
  const mimeType = getMimeType(contentType);
  if (!MARKDOWN_TYPES.has(mimeType ?? "")) {
    return content;
  }
  return marked.parse(content, { breaks: true, gfm: true }) as string;
}
