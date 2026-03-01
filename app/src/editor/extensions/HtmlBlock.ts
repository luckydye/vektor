import { mergeAttributes, Node } from "@tiptap/core";
import type { CommandProps } from "@tiptap/core";
import { stripScriptTags } from "~/src/utils/utils.ts";
import { render, html } from "lit-html";

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
        parseHTML: (element) =>
          element.getAttribute("data-html") || "<p>Enter HTML content here</p>",
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
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["html-block", mergeAttributes(HTMLAttributes)];
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

      const updateHtml = (e: Event) => {
        const textarea = e.target as HTMLInputElement;
        const newHtml = textarea.value;

        if (typeof getPos === "function") {
          const pos = getPos();
          if (pos) {
            view.dispatch(
              view.state.tr.setNodeMarkup(pos, undefined, {
                "data-html": newHtml,
              }),
            );
          }
        }

        renderSource();
      };

      function renderSource() {
        const htmlString = node.attrs["data-html"];

        render(
          html`
          <style>
            .html-block-wrapper {
              display: flex;
              gap: 1rem;
              margin: 1rem 0;
              width: 100%;
            }
            .html-block-toggle-btn {
              background: transparent;
              border: none;
              cursor: pointer;
              font-size: 1rem;
              padding: 0.25rem 0.5rem;
              border-radius: 0.25rem;
              transition: background-color 0.2s;
            }
            .html-block-toggle-btn:hover {
              background: var(--color-neutral-200);
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
            .w-full {
              width: 100%;
            }
          </style>

          <div class="html-block-wrapper">
            <div class="w-full" @keydown=${(e) => e.stopPropagation()} @paste=${(e) => e.stopPropagation()}>
              <ai-textarea
                .value=${htmlString}
                @change=${updateHtml}
                placeholder="Enter HTML content..."
                class="html-block-textarea"
              ></ai-textarea>
            </div>

            <div class="w-full">
              <html-block contentEditable="true" data-html=${htmlString}></html-block>
            </div>
          </div>
        `,
          dom,
        );
      }

      renderSource();

      return { dom };
    };
  },
});
