import type { CommandProps } from "@tiptap/core";
import { mergeAttributes, Node } from "@tiptap/core";
import { html, render } from "lit-html";

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

  addNodeView() {
    return ({ editor, node, getPos }) => {
      const { view } = editor;
      const dom = document.createElement("div");
      let currentNode = node;
      let isPreview = true;

      const updateHtml = (e: Event) => {
        const textarea = e.target as HTMLInputElement;
        const newHtml = textarea.value;

        if (typeof getPos === "function") {
          const pos = getPos();
          if (typeof pos === "number") {
            view.dispatch(
              view.state.tr.setNodeMarkup(pos, undefined, {
                "data-html": newHtml,
              }),
            );
          }
        }

        renderSource();
      };

      const toggleView = () => {
        isPreview = !isPreview;
        renderSource();
      };

      function renderSource() {
        const htmlString = currentNode.attrs["data-html"];

        render(
          html`
          <style>
            .html-block-wrapper {
              margin: 1rem 0;
              width: 100%;
              position: relative;
            }
            .html-block-toolbar {
              position: absolute;
              top: 0.75rem;
              right: 0.75rem;
              z-index: 1;
            }
            .html-block-toggle-btn {
              align-items: center;
              background: color-mix(in srgb, var(--color-background) 88%, transparent);
              border: 1px solid var(--color-neutral-200);
              cursor: pointer;
              backdrop-filter: blur(8px);
              border-radius: 999px;
              box-shadow: 0 1px 2px rgb(15 23 42 / 8%);
              color: var(--color-neutral-600);
              display: inline-flex;
              font-size: 0.75rem;
              font-weight: 600;
              gap: 0.375rem;
              letter-spacing: 0.01em;
              line-height: 1;
              padding: 0.5rem 0.625rem;
              transition: background-color 0.15s, border-color 0.15s, color 0.15s;
            }
            .html-block-toggle-btn:hover {
              background: var(--color-background);
              border-color: var(--color-neutral-300);
              color: var(--color-neutral-900);
            }
            .html-block-toggle-btn:focus-visible {
              outline: 2px solid var(--color-primary-400);
              outline-offset: 2px;
            }
            .html-block-toggle-icon {
              height: 0.875rem;
              width: 0.875rem;
            }
            .html-block-textarea {
              width: 100%;
            }
            .html-block-textarea::part(textarea) {
              min-height: 200px;
              height: 100%;
            }
            .html-block-content {
              word-break: break-word;
              overflow-wrap: break-word;
            }
            .html-block-preview {
              width: 100%;
            }
          </style>

          <div class="html-block-wrapper">
            <div class="html-block-toolbar">
              <button
                type="button"
                class="html-block-toggle-btn"
                @click=${toggleView}
                aria-pressed=${isPreview ? "true" : "false"}
                aria-label=${isPreview ? "Edit HTML source" : "Show HTML preview"}
              >
                ${
                  isPreview
                    ? html`<svg class="html-block-toggle-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.5 3 1.5 8l4 5M10.5 3l4 5-4 5M9 1.5 7 14.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> HTML`
                    : html`<svg class="html-block-toggle-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.5 8s2.2-4 6.5-4 6.5 4 6.5 4-2.2 4-6.5 4-6.5-4-6.5-4Z" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="1.75" fill="currentColor"/></svg> Preview`
                }
              </button>
            </div>

            ${
              isPreview
                ? html`<div class="html-block-preview"><html-block data-html=${htmlString}></html-block></div>`
                : html`
                    <div
                      @keydown=${(e: Event) => e.stopPropagation()}
                      @paste=${(e: Event) => e.stopPropagation()}
                    >
                      <ai-textarea
                        .value=${htmlString}
                        @change=${updateHtml}
                        placeholder="Enter HTML content..."
                        class="html-block-textarea"
                      ></ai-textarea>
                    </div>
                  `
            }
          </div>
        `,
          dom,
        );
      }

      renderSource();

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type !== currentNode.type) return false;
          currentNode = updatedNode;
          renderSource();
          return true;
        },
      };
    };
  },
});
