import type { JSONContent } from "@tiptap/core";
import { marked } from "marked";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const markdownRenderer = new marked.Renderer();
markdownRenderer.html = ({ text }: { text: string }) => escapeHtml(text);

function getDocumentReferenceId(href: string): string | null {
  if (href.startsWith("doc:")) return href.slice("doc:".length) || null;
  return href.match(/^\/[^/]+\/doc\/([^/?#]+)/)?.[1] ?? null;
}

markdownRenderer.link = function ({ href, title, tokens }) {
  const label = this.parser.parseInline(tokens);
  const safeHref = /^(?:https?:|mailto:|doc:|\/|#)/i.test(href) ? href : "#";
  const documentId = getDocumentReferenceId(safeHref);
  if (documentId) {
    return `<document-mention data-document-id="${escapeHtml(documentId)}" data-href="${escapeHtml(safeHref)}">${label}</document-mention>`;
  }
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(safeHref)}"${titleAttribute} target="_blank" rel="noopener noreferrer">${label}</a>`;
};

export function renderMessageMarkdown(content: string): string {
  return marked.parse(content, {
    breaks: true,
    gfm: true,
    renderer: markdownRenderer,
  }) as string;
}

export function messageMarkdownToHtml(content: string): string {
  return renderMessageMarkdown(content);
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, "\\$1");
}

function serializeInline(node: JSONContent): string {
  let content = escapeMarkdownText(node.text ?? "");
  const marks = node.marks ?? [];

  for (const mark of marks) {
    if (mark.type === "code") content = `\`${(node.text ?? "").replace(/`/g, "\\`")}\``;
    if (mark.type === "bold") content = `**${content}**`;
    if (mark.type === "italic") content = `*${content}*`;
    if (mark.type === "strike") content = `~~${content}~~`;
    if (mark.type === "link") {
      const href = String(mark.attrs?.href ?? "").replace(/[()]/g, "\\$&");
      content = `[${content}](${href})`;
    }
  }

  return content;
}

function serializeNode(node: JSONContent, depth = 0): string {
  if (node.type === "text") return serializeInline(node);
  if (node.type === "hardBreak") return "  \n";

  const children = node.content ?? [];
  const inline = () => children.map((child) => serializeNode(child, depth)).join("");

  switch (node.type) {
    case "mention": {
      const label = String(node.attrs?.label ?? node.attrs?.id ?? "").replace(/^@/, "");
      return label ? `@${escapeMarkdownText(label)}` : "";
    }
    case "documentMention": {
      const label = String(node.attrs?.label ?? node.attrs?.documentId ?? "").replace(
        /^@/,
        "",
      );
      const href = String(node.attrs?.href ?? "").replace(/[()]/g, "\\$&");
      return label && href ? `[@${escapeMarkdownText(label)}](${href})` : "";
    }
    case "doc":
      return children.map((child) => serializeNode(child, depth)).join("\n\n");
    case "paragraph":
      return inline();
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      return `${"#".repeat(level)} ${inline()}`;
    }
    case "bulletList":
      return children
        .map((child) => `${"  ".repeat(depth)}- ${serializeNode(child, depth + 1)}`)
        .join("\n");
    case "orderedList": {
      const start = Number(node.attrs?.start ?? 1);
      return children
        .map(
          (child, index) =>
            `${"  ".repeat(depth)}${start + index}. ${serializeNode(child, depth + 1)}`,
        )
        .join("\n");
    }
    case "listItem":
      return children.map((child) => serializeNode(child, depth)).join("\n");
    default:
      return inline();
  }
}

export function tiptapJsonToMarkdown(document: JSONContent): string {
  return serializeNode(document).trim();
}
