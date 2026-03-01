// Figma Embed Extension
//
// Shows a suggestion popup when a Figma URL is pasted, allowing the user
// to convert it into an embedded Figma viewer.
//
// Supported URL formats:
// - https://www.figma.com/file/XXXX/...
// - https://www.figma.com/design/XXXX/...
// - https://www.figma.com/proto/XXXX/...
// - https://www.figma.com/board/XXXX/...
//
// Usage:
// 1. Paste a Figma URL into the editor
// 2. A popup appears asking if you want to convert to embed
// 3. Click "Embed" to convert, or "Dismiss" to keep as plain text
//
// Example in editor.ts:
//   import { FigmaEmbed } from "./extensions/FigmaEmbed.ts";
//   // Add to extensions array:
//   FigmaEmbed,
//
// Note: Relies on the <figma-embed> custom element defined in utils/elements.ts

import { mergeAttributes, Node } from "@tiptap/core";
import type { CommandProps } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { ResizableNodeView, createResizableAttributes } from "./resizable.ts";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    figmaEmbed: {
      insertFigmaEmbed: (attributes: { url: string }) => ReturnType;
    };
  }
}

const FIGMA_URL_REGEX =
  /^https:\/\/(www\.)?figma\.com\/(file|design|proto|board)\/[a-zA-Z0-9]+/;

function isFigmaUrl(url: string): boolean {
  return FIGMA_URL_REGEX.test(url);
}

function createSuggestionPopup(
  onEmbed: () => void,
  onDismiss: () => void,
): HTMLDivElement {
  const popup = document.createElement("div");
  popup.style.cssText = `
    position: fixed;
    z-index: 50;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    padding: 12px;
    display: flex;
    align-items: center;
    gap: 12px;
  `;

  const label = document.createElement("span");
  label.textContent = "Convert to Figma embed?";
  label.style.cssText = "font-size: 14px; color: #374151;";

  const embedBtn = document.createElement("button");
  embedBtn.textContent = "Embed";
  embedBtn.style.cssText = `
    padding: 6px 12px;
    background: #7c3aed;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
  `;
  embedBtn.addEventListener("click", onEmbed);

  const dismissBtn = document.createElement("button");
  dismissBtn.textContent = "Dismiss";
  dismissBtn.style.cssText = `
    padding: 6px 12px;
    background: #f3f4f6;
    color: #374151;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
  `;
  dismissBtn.addEventListener("click", onDismiss);

  popup.appendChild(label);
  popup.appendChild(embedBtn);
  popup.appendChild(dismissBtn);

  return popup;
}

class ResizableFigmaView extends ResizableNodeView {
  figmaEl: HTMLElement;

  constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined) {
    super(node, view, getPos);

    this.figmaEl = document.createElement("figma-embed");
    this.figmaEl.dataset.figmaUrl = node.attrs.url;
    this.figmaEl.style.cssText = "display: block; width: 100%; height: 450px;";

    this.setupResizableContent(this.figmaEl, "height");
  }

  updateContent(): void {
    if (this.figmaEl.dataset.figmaUrl !== this.node.attrs.url) {
      this.figmaEl.dataset.figmaUrl = this.node.attrs.url;
    }
  }
}

export const FigmaEmbed = Node.create({
  name: "figmaEmbed",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      url: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-figma-url"),
        renderHTML: (attributes) => ({
          "data-figma-url": attributes.url,
        }),
      },
      ...createResizableAttributes(),
    };
  },

  parseHTML() {
    return [
      {
        tag: "figma-embed[data-figma-url]",
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    return ["figma-embed", mergeAttributes(HTMLAttributes), node.attrs.url];
  },

  addCommands() {
    return {
      insertFigmaEmbed:
        (attributes: { url: string }) =>
        ({ commands }: CommandProps) => {
          if (!isFigmaUrl(attributes.url)) {
            throw new Error(`Invalid Figma URL: ${attributes.url}`);
          }
          return commands.insertContent({
            type: this.name,
            attrs: { url: attributes.url },
          });
        },
    };
  },

  addNodeView() {
    return ({
      node,
      view,
      getPos,
    }: {
      node: ProseMirrorNode;
      view: EditorView;
      getPos: () => number | undefined;
    }) => {
      return new ResizableFigmaView(node, view, getPos);
    };
  },

  addProseMirrorPlugins() {
    const nodeType = this.type;
    let activePopup: HTMLDivElement | null = null;

    const cleanup = () => {
      if (activePopup) {
        activePopup.remove();
        activePopup = null;
      }
    };

    return [
      new Plugin({
        key: new PluginKey("figmaEmbedPaste"),
        props: {
          handlePaste(view, event) {
            const text = event.clipboardData?.getData("text/plain")?.trim();
            if (!text || !isFigmaUrl(text)) {
              return false;
            }

            cleanup();

            const { state, dispatch } = view;
            const { selection } = state;
            const insertPos = selection.from;

            const schema = state.schema;
            const textNode = schema.text(text);
            const tr = state.tr.insert(insertPos, textNode);
            dispatch(tr);

            const pastedTextStart = insertPos;
            const pastedTextEnd = insertPos + text.length;

            setTimeout(() => {
              const coords = view.coordsAtPos(pastedTextEnd);

              const popup = createSuggestionPopup(() => {
                const currentState = view.state;
                const embedNode = nodeType.create({ url: text });
                const replaceTr = currentState.tr.replaceRangeWith(
                  pastedTextStart,
                  pastedTextEnd,
                  embedNode,
                );
                view.dispatch(replaceTr);
                cleanup();
              }, cleanup);

              popup.style.left = `${coords.left}px`;
              popup.style.top = `${coords.bottom + 8}px`;

              document.body.appendChild(popup);
              activePopup = popup;
            }, 0);

            return true;
          },
        },
        view() {
          return {
            destroy: cleanup,
          };
        },
      }),
    ];
  },
});
