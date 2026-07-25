/**
 * Markdown in every direction the app needs it:
 *  - Markdown → HTML for chat messages and rich-text inputs (`renderMessageMarkdown`)
 *  - TipTap JSON → Markdown for message composition (`tiptapJsonToMarkdown`)
 *  - Document HTML → Markdown for the export endpoint and clipboard copy
 *    (`htmlToMarkdown`)
 */

import type { JSONContent } from "@tiptap/core";
import { marked } from "marked";
import {
  escapeHtml,
  type HtmlNode,
  type HtmlTagNode,
  type HtmlTextNode,
  parseHtml,
  reconstructNode,
  SyntaxKind,
} from "#utils/html.ts";

const markdownRenderer = new marked.Renderer();
markdownRenderer.html = ({ text }: { text: string }) => escapeHtml(text);

function getDocumentReferenceId(href: string): string | null {
  if (href.startsWith("doc:")) return href.slice("doc:".length) || null;
  return href.match(/^\/[^/]+\/doc\/([^/?#]+)/)?.[1] ?? null;
}

function getUserMentionEmail(href: string): string | null {
  if (href.startsWith("mention:"))
    return decodeURIComponent(href.slice("mention:".length)) || null;
  return null;
}

markdownRenderer.link = function ({ href, title, tokens }) {
  const label = this.parser.parseInline(tokens);
  const safeHref = /^(?:https?:|mailto:|doc:|mention:|\/|#)/i.test(href) ? href : "#";
  const documentId = getDocumentReferenceId(safeHref);
  if (documentId) {
    return `<document-mention data-document-id="${escapeHtml(documentId)}" data-href="${escapeHtml(safeHref)}">${label}</document-mention>`;
  }
  const mentionEmail = getUserMentionEmail(safeHref);
  if (mentionEmail) {
    return `<user-mention email="${escapeHtml(mentionEmail)}">${label}</user-mention>`;
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
      const id = String(node.attrs?.id ?? "");
      if (!label) return "";
      if (!id) return `@${escapeMarkdownText(label)}`;
      const href = encodeURIComponent(id).replace(/[()]/g, "\\$&");
      return `[@${escapeMarkdownText(label)}](mention:${href})`;
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

// ---------------------------------------------------------------------------
// Document HTML → Markdown
// ---------------------------------------------------------------------------

function getAttr(node: HtmlTagNode, name: string): string | undefined {
  return node.attributes?.find((a) => a.name.value === name)?.value?.value;
}

function getTextContent(nodes: HtmlNode[]): string {
  let text = "";
  for (const node of nodes) {
    if (node.type === SyntaxKind.Text) {
      text += (node as HtmlTextNode).value;
    } else if (node.type === SyntaxKind.Tag) {
      const body = (node as HtmlTagNode).body;
      if (body) text += getTextContent(body);
    }
  }
  return text;
}

// Elements that should be kept as raw HTML in the markdown output
const HTML_PASSTHROUGH_TAGS = new Set([
  "table",
  "figma-embed",
  "file-attachment",
  "document-attachment",
]);

// Check if a div is a column layout
function isColumnLayout(node: HtmlTagNode): boolean {
  return node.name === "div" && getAttr(node, "data-type") === "column-layout";
}

function nodeToMarkdown(node: HtmlNode): string {
  if (node.type === SyntaxKind.Text) {
    return (node as HtmlTextNode).value;
  }

  if (node.type !== SyntaxKind.Tag) return "";

  const tag = node as HtmlTagNode;
  const name = tag.name.toLowerCase();
  const children = tag.body || [];
  const childContent = () => children.map(nodeToMarkdown).join("");

  // HTML passthrough - keep as raw HTML
  if (HTML_PASSTHROUGH_TAGS.has(name) || isColumnLayout(tag)) {
    return `\n\n${reconstructNode(tag)}\n\n`;
  }

  // Ignore html-block elements entirely
  if (name === "html-block") return "";

  switch (name) {
    // Block elements
    case "h1":
      return `\n\n# ${childContent().trim()}\n\n`;
    case "h2":
      return `\n\n## ${childContent().trim()}\n\n`;
    case "h3":
      return `\n\n### ${childContent().trim()}\n\n`;
    case "p":
      return `\n\n${childContent().trim()}\n\n`;
    case "blockquote":
      return `\n\n> ${childContent().trim().replace(/\n/g, "\n> ")}\n\n`;
    case "hr":
      return "\n\n---\n\n";
    case "br":
      return "\n";

    // Lists
    case "ul":
    case "ol":
      return `\n\n${childContent()}\n`;
    case "li": {
      const isTask = getAttr(tag, "data-type") === "taskItem";
      const checked = getAttr(tag, "data-checked") === "true";
      const prefix = isTask ? (checked ? "- [x] " : "- [ ] ") : "- ";
      return `${prefix + childContent().trim()}\n`;
    }

    // Inline formatting
    case "strong":
    case "b":
      return `**${childContent()}**`;
    case "em":
    case "i":
      return `*${childContent()}*`;
    case "s":
    case "strike":
      return `~~${childContent()}~~`;
    case "u":
      return `<u>${childContent()}</u>`;
    case "code":
      return `\`${childContent()}\``;
    case "sub":
      return `<sub>${childContent()}</sub>`;
    case "sup":
      return `<sup>${childContent()}</sup>`;

    // Links and images
    case "a": {
      const href = getAttr(tag, "href") || "";
      return `[${childContent()}](${href})`;
    }
    case "img": {
      const src = getAttr(tag, "src") || "";
      const alt = getAttr(tag, "alt") || "";
      return `![${alt}](${src})`;
    }

    // Code blocks
    case "pre": {
      const codeNode = children.find(
        (c) => c.type === SyntaxKind.Tag && (c as HtmlTagNode).name === "code",
      ) as HtmlTagNode | undefined;
      const text = codeNode ? getTextContent(codeNode.body || []) : childContent();
      const lang =
        codeNode?.attributes
          ?.find((a) => a.name.value === "class")
          ?.value?.value?.match(/language-(\w+)/)?.[1] || "";
      return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
    }

    // Custom TipTap elements
    case "user-mention": {
      const email = getAttr(tag, "email") || "";
      const label = getTextContent(children).replace(/^@/, "");
      return `[@${label}](mailto:${email})`;
    }
    case "document-mention": {
      const href = getAttr(tag, "data-href") || "";
      const label = getTextContent(children);
      return href ? `[${label}](${href})` : label;
    }
    case "ticket-link": {
      const ticketId = getAttr(tag, "data-ticket-id") || childContent();
      const url = getAttr(tag, "data-connection-url");
      if (url) {
        const cleanId = ticketId.replace("#", "");
        const fullUrl = url.endsWith("/") ? `${url}${cleanId}` : `${url}/${cleanId}`;
        return `[${ticketId}](${fullUrl})`;
      }
      return ticketId;
    }
    case "date-picker": {
      const dateStr = getAttr(tag, "data-date") || "";
      try {
        return new Date(dateStr).toLocaleDateString("en-AU", {
          year: "numeric",
          month: "long",
          day: "numeric",
        });
      } catch {
        return dateStr;
      }
    }
    case "expression-cell": {
      return getAttr(tag, "data-formula") || getTextContent(children) || "=";
    }

    // Default: just render children
    default:
      return childContent();
  }
}

export function htmlToMarkdown(html: string): string {
  if (!html) return "";
  const ast = parseHtml(html);
  return ast
    .map(nodeToMarkdown)
    .join("")
    .trim()
    .replace(/\n{3,}/g, "\n\n");
}
