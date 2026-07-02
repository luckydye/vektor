import { Extension } from "@tiptap/core";
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

function dispatchTableSelectionPointerState(active: boolean) {
  window.dispatchEvent(
    new CustomEvent("table-selection-pointer-state", {
      detail: { active },
    }),
  );
}

function isTableCellTarget(target: EventTarget | null, view: EditorView) {
  if (!(target instanceof Element) || !view.dom.contains(target)) {
    return false;
  }

  return target.closest("td, th") !== null;
}

export const TableEditing = Extension.create({
  name: "tableEditing",

  addExtensions() {
    return [
      Table.extend({
        addKeyboardShortcuts: () => ({}),
      }).configure({
        resizable: true,
      }),
      TableRow.extend({
        addKeyboardShortcuts: () => ({}),
      }),
      TableHeader.extend({
        addAttributes(this: { parent?: () => Record<string, unknown> }) {
          return {
            ...this.parent?.(),
            colwidth: colwidthAttribute,
          };
        },
        addKeyboardShortcuts: () => ({}),
      }),
      TableCell.extend({
        addAttributes(this: { parent?: () => Record<string, unknown> }) {
          return {
            ...this.parent?.(),
            colwidth: colwidthAttribute,
            backgroundColor: {
              default: null,
              parseHTML: (element: HTMLElement) => element.style.backgroundColor || null,
              renderHTML: (attributes: { backgroundColor?: string }) => {
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
        addKeyboardShortcuts: () => ({}),
      }),
      ExpressionCell,
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        view: (view) => {
          syncCellSelectionUi(view);
          let pointerDownInTable = false;
          let dispatchedPointerState = false;

          const syncPointerSelection = (view: EditorView) => {
            const active =
              pointerDownInTable && view.state.selection instanceof CellSelection;
            view.dom.classList.toggle("table-cell-selection-dragging", active);
            if (active === dispatchedPointerState) return;
            dispatchedPointerState = active;
            dispatchTableSelectionPointerState(active);
          };

          const endPointerSelection = () => {
            if (!pointerDownInTable) return;
            pointerDownInTable = false;
            syncPointerSelection(view);
          };

          const handleMouseDown = (event: MouseEvent) => {
            if (event.button !== 0 || !isTableCellTarget(event.target, view)) {
              return;
            }

            pointerDownInTable = true;
            syncPointerSelection(view);
          };

          view.dom.addEventListener("mousedown", handleMouseDown);
          view.root.addEventListener("mouseup", endPointerSelection);
          view.root.addEventListener("dragstart", endPointerSelection);

          return {
            update(view) {
              syncCellSelectionUi(view);
              syncPointerSelection(view);
            },
            destroy() {
              view.dom.removeEventListener("mousedown", handleMouseDown);
              view.root.removeEventListener("mouseup", endPointerSelection);
              view.root.removeEventListener("dragstart", endPointerSelection);
              endPointerSelection();
              view.dom.classList.remove("table-cell-selection-active");
              view.dom.classList.remove("table-cell-selection-dragging");
            },
          };
        },
      }),
    ];
  },
});
