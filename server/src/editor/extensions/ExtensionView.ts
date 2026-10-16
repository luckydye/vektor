import type { CommandProps } from "@tiptap/core";
import { Node } from "@tiptap/core";
import { extensions } from "#extensions/manager.ts";
import { nodeFromSpec } from "./specSchema.ts";

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
  ...nodeFromSpec("extensionView"),

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
        extensions
          .renderInlineView(extensionId, routePath, dom)
          .then((fn) => {
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
