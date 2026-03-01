import { mergeAttributes, Node } from "@tiptap/core";
import type { CommandProps } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    expressionCell: {
      insertExpressionCell: (attributes?: { formula?: string }) => ReturnType;
    };
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "expression-cell": HTMLElement;
  }
}

export const ExpressionCell = Node.create({
  name: "expressionCell",
  group: "inline",
  inline: true,
  content: "text*",
  atom: false,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      "data-formula": {
        default: "=",
        parseHTML: (element) =>
          element.getAttribute("data-formula") || element.textContent?.trim() || "=",
        renderHTML: (attributes) => {
          return {
            "data-formula": attributes["data-formula"],
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "expression-cell",
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    const attrs = mergeAttributes(HTMLAttributes);
    if (node.attrs["data-formula"]) {
      attrs["data-formula"] = node.attrs["data-formula"];
    } else if (node.textContent) {
      attrs["data-formula"] = node.textContent;
    }
    return ["expression-cell", attrs, 0];
  },

  addCommands() {
    return {
      insertExpressionCell:
        (attributes?: { formula?: string }) =>
        ({ commands, state }: CommandProps) => {
          const formula = attributes?.formula || "=";
          return commands.insertContent({
            type: this.name,
            attrs: {
              "data-formula": formula,
            },
            content: [
              {
                type: "text",
                text: formula,
              },
            ],
          });
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("expressionCellSyncFormula"),
        appendTransaction(transactions, oldState, newState) {
          const tr = newState.tr;
          let modified = false;

          newState.doc.descendants((node, pos) => {
            if (node.type.name === "expressionCell") {
              const currentFormula = node.attrs["data-formula"];
              const textContent = node.textContent;

              if (textContent && textContent !== currentFormula) {
                tr.setNodeMarkup(pos, undefined, {
                  ...node.attrs,
                  "data-formula": textContent,
                });
                modified = true;
              }
            }
          });

          return modified ? tr : null;
        },
      }),
      new Plugin({
        key: new PluginKey("expressionCellAutoConvert"),
        props: {
          handleTextInput(view, from, to, text) {
            const { state } = view;
            const { $from } = state.selection;

            // Check if we're in a table cell
            let inTableCell = false;
            for (let d = $from.depth; d > 0; d--) {
              const node = $from.node(d);
              if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
                inTableCell = true;
                break;
              }
            }

            if (!inTableCell) {
              return false;
            }

            // Check if user typed "=" at the start of the cell
            if (text === "=") {
              const cellNode = $from.parent;

              // Only convert if cell is empty or cursor is at the very start
              if (cellNode.content.size === 0 || $from.parentOffset === 0) {
                const tr = state.tr;
                const cellStart = $from.start();

                // If there's existing content and we're at start, don't convert
                if (cellNode.content.size > 0 && $from.parentOffset === 0) {
                  return false;
                }

                // Create expression-cell node with "=" as initial content
                const expressionNode = state.schema.nodes.expressionCell.create(
                  {
                    "data-formula": "=",
                  },
                  [state.schema.text("=")],
                );

                // Replace and set selection inside the expression cell
                tr.replaceWith(cellStart, cellStart, expressionNode);

                // Set cursor after the "="
                const newPos = cellStart + 2;
                tr.setSelection(TextSelection.create(tr.doc, newPos));

                view.dispatch(tr);
                return true;
              }
            }

            return false;
          },
        },
      }),
    ];
  },
});
