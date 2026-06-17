import type { CommandProps } from "@tiptap/core";
import { mergeAttributes, Node } from "@tiptap/core";
import { extensions } from "~/src/utils/extensions.ts";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    extensionView: {
      insertExtensionView: (attrs: {
        extensionId: string;
        routePath: string;
      }) => ReturnType;
    };
  }
}

export const ExtensionView = Node.create({
  name: "extensionView",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      extensionId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-extension-id"),
        renderHTML: (attributes) => ({
          "data-extension-id": attributes.extensionId,
        }),
      },
      routePath: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-route-path"),
        renderHTML: (attributes) => ({
          "data-route-path": attributes.routePath,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "extension-view-block[data-extension-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["extension-view-block", mergeAttributes(HTMLAttributes)];
  },

  addCommands() {
    return {
      insertExtensionView:
        (attrs: { extensionId: string; routePath: string }) =>
        ({ commands }: CommandProps) => {
          return commands.insertContent({
            type: this.name,
            attrs,
          });
        },
    };
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "extension-view-block";

      const { extensionId, routePath } = node.attrs as {
        extensionId: string | null;
        routePath: string | null;
      };

      let cleanup: (() => void) | null = null;

      if (extensionId && routePath) {
        extensions.renderInlineView(extensionId, routePath, dom).then((fn) => {
          cleanup = fn;
          if (!fn) {
            const placeholder = document.createElement("div");
            placeholder.className = "extension-view-block__unavailable";
            placeholder.textContent = "Extension view unavailable";
            placeholder.style.cssText =
              "padding: 1rem; color: var(--color-neutral-500); font-size: 0.875rem;";
            dom.appendChild(placeholder);
          }
        });
      }

      return {
        dom,
        destroy() {
          if (cleanup) {
            cleanup();
            cleanup = null;
          }
        },
      };
    };
  },
});
