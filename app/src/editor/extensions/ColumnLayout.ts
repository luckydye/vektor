import { mergeAttributes, Node } from "@tiptap/core";
import type { CommandProps } from "@tiptap/core";

export interface ColumnLayoutOptions {
  columns: number;
}

export const ColumnLayout = Node.create<ColumnLayoutOptions>({
  name: "columnLayout",
  group: "block",
  content: "columnItem+",
  isolating: true,
  draggable: true,

  addAttributes() {
    return {
      columns: {
        default: 2,
        parseHTML: (element) => {
          return Number.parseInt(element.getAttribute("data-columns") || "2", 10);
        },
        renderHTML: (attributes) => {
          return {
            "data-columns": attributes.columns,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="column-layout"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "column-layout" }), 0];
  },

  addCommands() {
    return {
      setColumnLayout:
        (options: { columns: number }) =>
        ({ commands }: CommandProps) => {
          const { columns } = options;
          const columnItems = Array.from({ length: columns }, () => ({
            type: "columnItem",
            content: [{ type: "paragraph" }],
          }));

          return commands.insertContent({
            type: this.name,
            attrs: { columns },
            content: columnItems,
          });
        },
    };
  },
});

export const ColumnItem = Node.create({
  name: "columnItem",
  content: "block+",
  isolating: true,

  parseHTML() {
    return [
      {
        tag: 'div[data-type="column-item"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "column-item" }), 0];
  },
});
