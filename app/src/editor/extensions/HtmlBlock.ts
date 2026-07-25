import type { CommandProps } from "@tiptap/core";
import { mergeAttributes, Node } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    htmlBlock: {
      insertHtmlBlock: (attributes?: { html?: string }) => ReturnType;
    };
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "html-block": HTMLElement;
  }
}

// These elements have no TipTap representation. Without an explicit fallback,
// ProseMirror drops their element and attributes, then parses only their text
// children. Keep the complete source in an HTML block instead.
const UNSUPPORTED_BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "audio",
  "canvas",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "hgroup",
  "iframe",
  "main",
  "menu",
  "nav",
  "noscript",
  "object",
  "output",
  "picture",
  "section",
  "svg",
  "template",
  "video",
]);

function isUnsupportedHtmlBlock(element: HTMLElement): boolean {
  const tagName = element.tagName.toLowerCase();
  return UNSUPPORTED_BLOCK_TAGS.has(tagName) || tagName.includes("-");
}

// Content-holding nodes the schema understands. When ProseMirror descends into
// one of these to parse its children, any unsupported element it encounters is
// nested content, not a root-level block — hoisting it into its own HTML block
// would swallow it (e.g. a task item's <div><p>…</p></div> content wrapper,
// since <div> is an unsupported tag). Unsupported elements nested inside another
// *unsupported* element never reach here: that ancestor is captured as an atom
// first, so ProseMirror stops descending. So an ancestor from this set is the
// only way getAttrs sees a non-root element.
const CONTENT_CONTAINER_TAGS = new Set([
  "ul",
  "ol",
  "li",
  "blockquote",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
]);

function isNestedInContentNode(element: HTMLElement): boolean {
  let parent = element.parentElement;
  while (parent) {
    const tagName = parent.tagName.toLowerCase();
    if (CONTENT_CONTAINER_TAGS.has(tagName) || parent.hasAttribute("data-type")) {
      return true;
    }
    parent = parent.parentElement;
  }
  return false;
}

function parseHtmlBlockContent(element: HTMLElement): string | null {
  const value = element.getAttribute("data-html");
  if (value === null) return null;
  if (element.getAttribute("data-html-encoding") !== "uri") return value;

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Schema-only HTML block: parsing, attributes and HTML rendering, with no DOM
 * rendering library imported. The server builds this through `contentExtensions`
 * to (de)serialize documents, so this module must stay free of lit-html — the
 * interactive editing view lives in `HtmlBlockNodeView.ts` and is injected
 * client-side by `documentExtensions`.
 */
export const HtmlBlock = Node.create({
  name: "htmlBlock",
  group: "block",
  atom: true,
  selectable: false,
  draggable: true,

  addAttributes() {
    return {
      "data-html": {
        default: "<p>Enter HTML content here</p>",
        parseHTML: parseHtmlBlockContent,
        renderHTML: (attributes) => {
          return {
            "data-html": attributes["data-html"],
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "html-block",
      },
      {
        // Run after every native and Vektor-specific parser rule, so this
        // captures only elements the document schema does not understand.
        tag: "*",
        priority: 1,
        getAttrs: (element) => {
          if (!isUnsupportedHtmlBlock(element)) return false;
          // Only hoist root-level unknown HTML into a block. Nested unknown
          // markup belongs to the node being parsed and is left in place.
          if (isNestedInContentNode(element)) return false;
          return { "data-html": element.outerHTML };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const htmlContent = String(HTMLAttributes["data-html"] ?? "");
    return [
      "html-block",
      mergeAttributes(HTMLAttributes, {
        "data-html": encodeURIComponent(htmlContent),
        "data-html-encoding": "uri",
      }),
    ];
  },

  addCommands() {
    return {
      insertHtmlBlock:
        (attributes?: { html?: string }) =>
        ({ commands }: CommandProps) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              "data-html": attributes?.html || "<p>Enter HTML content here</p>",
            },
          });
        },
    };
  },
});
