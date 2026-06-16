import { Extension } from "@tiptap/core";
import { Marked } from "marked";
import { Plugin, PluginKey } from "@tiptap/pm/state";

function wrapInParagraph(content: string): string {
  if (/^<(p|ul|ol|h[1-6]|blockquote|pre|div)\b/.test(content)) return content;
  const blockStart = content.search(/<(ul|ol|p|h[1-6]|blockquote|pre|div)\b/);
  if (blockStart > 0)
    return `<p>${content.slice(0, blockStart).trimEnd()}</p>${content.slice(blockStart)}`;
  return `<p>${content.trimEnd()}</p>`;
}

// Isolated marked instance — does not mutate the global marked export.
// Renderer mirrors documentContent.ts so task lists are Tiptap-compatible.
const md = new Marked();
md.use({
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

// Patterns that indicate pasted text is intentional markdown (not plain prose).
const MARKDOWN_PATTERNS = [
  /^#{1,6}\s+\S/m,         // headings
  /\*\*[^*\n]+\*\*/,       // bold **text**
  /^[-*+]\s+\S/m,          // unordered list item
  /^\d+\.\s+\S/m,          // ordered list item
  /^>\s+\S/m,              // blockquote
  /^```/m,                 // fenced code block
  /\[[^\]]+\]\([^)]+\)/,  // link [text](url)
  /^---+\s*$/m,            // horizontal rule
] as const;

function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_PATTERNS.some((p) => p.test(text));
}

// If the clipboard HTML already contains rich formatting, trust it over plain text.
const RICH_HTML_RE = /<(strong|b|em|i|h[1-6]|ul|ol|table|code|pre|blockquote)\b/i;

export const MarkdownPaste = Extension.create({
  name: "markdownPaste",

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: new PluginKey("markdownPaste"),
        props: {
          handlePaste(_view, event) {
            const clipboardHtml = event.clipboardData?.getData("text/html") ?? "";
            if (RICH_HTML_RE.test(clipboardHtml)) {
              // Rich text already in clipboard — defer to Tiptap's default handler.
              return false;
            }

            const text = event.clipboardData?.getData("text/plain") ?? "";
            if (!text.trim() || !looksLikeMarkdown(text)) {
              return false;
            }

            const html = md.parse(text, { async: false, breaks: false, gfm: true }) as string;
            event.preventDefault();
            editor.commands.insertContent(html);
            return true;
          },
        },
      }),
    ];
  },
});
