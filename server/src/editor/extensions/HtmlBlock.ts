import type { CommandProps } from "@tiptap/core";
import { Node } from "@tiptap/core";
import type { TagParseRule } from "@tiptap/pm/model";
import { CONTENT_CONTAINER_TAGS, isHtmlBlockTag } from "#documents/schema/specs.ts";
import { nodeFromSpec, specParseRules } from "./specSchema.ts";

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

/**
 * Whether an element is nested inside a content-holding node the schema
 * understands. Unsupported markup below one of those is that node's content,
 * not a root-level block — hoisting it into its own HTML block would swallow
 * the node it belongs to (a task item's `<div><p>…</p></div>` wrapper, say,
 * since `div` is an unsupported tag).
 *
 * Unsupported elements nested inside another *unsupported* element never reach
 * here: that ancestor is captured as an atom first, so ProseMirror stops
 * descending. An ancestor from the container set is the only way this is
 * reached for a non-root element.
 */
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

/**
 * Schema-only HTML block: parsing, attributes and HTML rendering, with no DOM
 * rendering library imported. The interactive editing view lives in
 * `HtmlBlockNodeView.ts` and is injected client-side by `documentExtensions`.
 *
 * The catch-all rule below is the one parse rule that cannot come from the spec
 * table: deciding whether an unknown element is a root-level block needs its
 * ancestors, which a tag matcher cannot see. `parse.ts` runs the same logic on
 * the server, driven by the same two exported tag sets.
 */
export const HtmlBlock = Node.create({
  name: "htmlBlock",
  ...nodeFromSpec("htmlBlock"),

  parseHTML(): TagParseRule[] {
    return [
      ...specParseRules("htmlBlock"),
      {
        // Runs after every native and Vektor-specific parser rule, so this
        // captures only elements the document schema does not understand.
        tag: "*",
        priority: 1,
        getAttrs: (element) => {
          if (typeof element === "string") return false;
          if (!isHtmlBlockTag(element.tagName.toLowerCase())) return false;
          // Only hoist root-level unknown HTML into a block. Nested unknown
          // markup belongs to the node being parsed and is left in place.
          if (isNestedInContentNode(element)) return false;
          return { "data-html": element.outerHTML };
        },
      },
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
