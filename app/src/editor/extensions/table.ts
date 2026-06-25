import { type AnyExtension, Extension } from "@tiptap/core";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Plugin } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";
import { ExpressionCell } from "./ExpressionCell.ts";

const colwidthAttribute = {
  default: [200],
  parseHTML: (element: HTMLElement) => {
    const colwidth = element.getAttribute("colwidth");
    return colwidth ? colwidth.split(",").map((w) => parseInt(w, 10)) : [200];
  },
  renderHTML: (attributes: { colwidth?: number[] }) => {
    if (!attributes.colwidth) {
      return { style: "width: 200px" };
    }
    return {
      colwidth: attributes.colwidth.join(","),
      style: `width: ${attributes.colwidth[0]}px`,
    };
  },
};

function withoutDefaultKeyboardShortcuts<T extends AnyExtension>(extension: T): T {
  return extension.extend({
    addKeyboardShortcuts: () => ({}),
  }) as T;
}

function clearNativeSelection(view: EditorView) {
  const root = view.root;
  const selection =
    "getSelection" in root && typeof root.getSelection === "function"
      ? root.getSelection()
      : window.getSelection();

  if (!selection?.isCollapsed) {
    selection?.removeAllRanges();
  }
}

function syncCellSelectionUi(view: EditorView) {
  const hasCellSelection = view.state.selection instanceof CellSelection;
  view.dom.classList.toggle("table-cell-selection-active", hasCellSelection);

  if (hasCellSelection) {
    clearNativeSelection(view);
  }
}

export const TableEditing = Extension.create({
  name: "tableEditing",

  addExtensions() {
    return [
      withoutDefaultKeyboardShortcuts(
        Table.configure({
          resizable: true,
        }),
      ),
      withoutDefaultKeyboardShortcuts(TableRow),
      withoutDefaultKeyboardShortcuts(
        TableHeader.extend({
          addAttributes() {
            return {
              ...this.parent?.(),
              colwidth: colwidthAttribute,
            };
          },
        }),
      ),
      withoutDefaultKeyboardShortcuts(
        TableCell.extend({
          addAttributes() {
            return {
              ...this.parent?.(),
              colwidth: colwidthAttribute,
              backgroundColor: {
                default: null,
                parseHTML: (element) => element.style.backgroundColor || null,
                renderHTML: (attributes) => {
                  if (!attributes.backgroundColor) {
                    return {};
                  }
                  return {
                    style: `background-color: ${attributes.backgroundColor}`,
                  };
                },
              },
            };
          },
        }),
      ),
      ExpressionCell,
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        view: (view) => {
          syncCellSelectionUi(view);

          return {
            update(view) {
              syncCellSelectionUi(view);
            },
            destroy() {
              view.dom.classList.remove("table-cell-selection-active");
            },
          };
        },
      }),
    ];
  },
});
