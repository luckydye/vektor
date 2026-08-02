import { Extension } from "@tiptap/core";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Plugin } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";
import { ExpressionCell } from "./ExpressionCell.ts";
import { nodeFromSpec } from "./specSchema.ts";

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
    // The table package supplies the editing behaviour — commands, the
    // tableEditing plugin, column resizing. Its schema half is replaced with
    // the shared spec table, so the server serializes tables without it.
    return [
      Table.extend({
        addKeyboardShortcuts: () => ({}),
        ...nodeFromSpec("table"),
      }).configure({
        resizable: true,
      }),
      TableRow.extend({
        addKeyboardShortcuts: () => ({}),
        ...nodeFromSpec("tableRow"),
      }),
      TableHeader.extend({
        addKeyboardShortcuts: () => ({}),
        ...nodeFromSpec("tableHeader"),
      }),
      TableCell.extend({
        addKeyboardShortcuts: () => ({}),
        ...nodeFromSpec("tableCell"),
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
