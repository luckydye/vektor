import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

function textFromClipboardItem(item: DataTransferItem): Promise<string> {
  return new Promise((resolve) => item.getAsString(resolve));
}

type RichClipboardList = {
  items: Array<{ content: string; children: RichClipboardList[] }>;
};

type RichClipboardBullet = {
  content: string;
  indent: number;
};

function bulletContent(element: HTMLDivElement): string | null {
  if (!element.textContent?.trimStart().startsWith("•")) return null;

  const copy = element.cloneNode(true) as HTMLDivElement;
  const walker = copy.ownerDocument.createTreeWalker(
    copy,
    4 /* NodeFilter.SHOW_TEXT */,
  );
  let removePrefix = true;
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    if (removePrefix) {
      const marker = node.data.indexOf("•");
      if (marker < 0) {
        node.data = "";
        continue;
      }
      node.data = node.data.slice(marker + 1).replace(/^[\s\u00a0]+/, "");
      removePrefix = false;
      continue;
    }

    node.data = node.data.replace(/^[\s\u00a0]+/, "");
    if (node.data) break;
  }

  return copy.innerHTML.trim() || null;
}

function renderBulletList(bullets: RichClipboardBullet[]): string {
  const baseIndent = Math.min(
    ...bullets.map((bullet) => bullet.indent).filter((indent) => indent > 0),
  );
  const roots: RichClipboardList[] = [];
  const stack: RichClipboardList[] = [];

  for (const bullet of bullets) {
    let depth =
      Number.isFinite(baseIndent) && baseIndent > 0
        ? Math.max(0, Math.round(bullet.indent / baseIndent) - 1)
        : 0;
    depth = Math.min(depth, stack.length);

    if (depth === 0) {
      if (!stack[0]) {
        const list = { items: [] } satisfies RichClipboardList;
        roots.push(list);
        stack.push(list);
      }
      stack.length = 1;
    } else {
      const parent = stack[depth - 1]?.items.at(-1);
      if (!parent) {
        depth = 0;
        const list = { items: [] } satisfies RichClipboardList;
        roots.push(list);
        stack.length = 0;
        stack.push(list);
      } else if (!stack[depth]) {
        const list = { items: [] } satisfies RichClipboardList;
        parent.children.push(list);
        stack.length = depth;
        stack.push(list);
      } else {
        stack.length = depth + 1;
      }
    }

    stack[depth]?.items.push({ content: bullet.content, children: [] });
  }

  const renderList = (list: RichClipboardList): string =>
    `<ul>${list.items
      .map(
        (item) => `<li>${item.content}${item.children.map(renderList).join("")}</li>`,
      )
      .join("")}</ul>`;
  return roots.map(renderList).join("");
}

function hasBlockChild(element: HTMLDivElement): boolean {
  return Array.from(element.children).some((child) =>
    /^(?:article|aside|blockquote|div|h[1-6]|ol|p|pre|section|table|ul)$/i.test(
      child.tagName,
    ),
  );
}

function normalizeHtmlNodes(nodes: Iterable<Element>): string {
  const html: string[] = [];
  let bullets: RichClipboardBullet[] = [];
  let list: { tagName: "ol" | "ul"; content: string } | null = null;
  const flushBullets = () => {
    if (bullets.length) html.push(renderBulletList(bullets));
    bullets = [];
  };
  const flushList = () => {
    if (list) html.push(`<${list.tagName}>${list.content}</${list.tagName}>`);
    list = null;
  };

  for (const node of nodes) {
    const tagName = node.tagName.toLowerCase();
    if (tagName === "ul" || tagName === "ol") {
      flushBullets();
      if (list?.tagName === tagName) {
        list.content += node.innerHTML;
      } else {
        flushList();
        list = { tagName, content: node.innerHTML };
      }
      continue;
    }

    // Rich clipboard HTML often uses a <br> only to separate adjacent block
    // elements. Keeping it creates an empty paragraph in addition to the
    // normal margins of the surrounding blocks.
    if (tagName === "br") continue;

    flushList();
    if (node instanceof HTMLDivElement) {
      const content = bulletContent(node);
      if (content) {
        bullets.push({
          content,
          indent: Number.parseFloat(node.style.marginLeft) || 0,
        });
        continue;
      }

      if (hasBlockChild(node)) {
        flushBullets();
        html.push(normalizeHtmlNodes(node.children));
      } else {
        flushBullets();
        // Rich-text producers commonly use divs for ordinary paragraphs. Keep
        // their inline marks but drop the wrapper before the document parser
        // can turn it into an HTML block.
        html.push(`<p>${node.innerHTML}</p>`);
      }
      continue;
    }

    flushBullets();
    html.push(node.outerHTML);
  }

  flushBullets();
  flushList();
  return html.join("");
}

function looksLikeHtml(value: string): boolean {
  return /<(?:!doctype|html|head|body|article|blockquote|div|h[1-6]|ol|p|pre|section|table|ul)\b/i.test(
    value,
  );
}

function richClipboardHtml(values: Iterable<string>): string | null {
  if (typeof DOMParser === "undefined") return null;

  const source = [...values].find(looksLikeHtml);
  if (!source) return null;

  const doc = new DOMParser().parseFromString(source, "text/html");
  return normalizeHtmlNodes(doc.body.children) || null;
}

/**
 * Some platform clipboards expose rich HTML, plain text, and RTF as repeated
 * `text/plain` items. Select the HTML representation by its contents, then
 * normalize generic rich-text wrappers before passing it to the document
 * schema.
 */
export const RichClipboardPaste = Extension.create({
  name: "richClipboardPaste",

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: new PluginKey("richClipboardPaste"),
        props: {
          handlePaste(_view, event) {
            const data = event.clipboardData;
            if (!data) return false;

            const directHtml = data.getData("text/html");
            const normalizedDirectHtml = richClipboardHtml([directHtml]);
            if (normalizedDirectHtml) {
              event.preventDefault();
              editor.chain().focus().insertContent(normalizedDirectHtml).run();
              return true;
            }

            const textItems = Array.from(data.items).filter(
              (item) => item.kind === "string" && item.type === "text/plain",
            );
            if (textItems.length < 2) return false;

            // `getAsString` is asynchronous, so prevent the browser fallback
            // before it can paste one arbitrary representation from the set.
            event.preventDefault();
            void Promise.all(textItems.map(textFromClipboardItem)).then((texts) => {
              const html = richClipboardHtml(texts);
              editor
                .chain()
                .focus()
                .insertContent(html ?? data.getData("text/plain"))
                .run();
            });
            return true;
          },
        },
      }),
    ];
  },
});
