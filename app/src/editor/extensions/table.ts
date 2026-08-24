import { Extension } from "@tiptap/core";
import {
  createTable,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  TableView,
} from "@tiptap/extension-table";
import type { Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import { NodeSelection, Plugin, Selection } from "@tiptap/pm/state";
import {
  addColumn,
  addRow,
  CellSelection,
  __clipCells as clipCells,
  deleteColumn,
  deleteRow,
  deleteTable,
  __insertCells as insertCells,
  isInTable,
  __pastedCells as pastedCells,
  selectedRect,
  TableMap,
} from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";
import {
  canConvertToSpreadsheet,
  isSpreadsheetTable,
  SPREADSHEET_TABLE_KIND,
} from "#spreadsheet/documentTable.ts";
import { SpreadsheetTableView } from "./SpreadsheetTableView.tsx";
import { nodeFromSpec } from "./specSchema.ts";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    spreadsheetTable: {
      insertSpreadsheetTable: (options?: { rows?: number; cols?: number }) => ReturnType;
      convertTableToSpreadsheet: () => ReturnType;
    };
  }
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

const CELLS_CLIPBOARD_MIME = "application/x-vektor-table-cells";
const CELLS_CLIPBOARD_ATTRIBUTE = "data-vektor-table-cells";

type CellAxis = "rows" | "columns";

/** Null unless the selection covers whole rows or whole columns. */
function selectionAxis(selection: Selection): CellAxis | null {
  if (!(selection instanceof CellSelection)) return null;
  if (selection.isRowSelection()) return "rows";
  if (selection.isColSelection()) return "columns";
  return null;
}

/**
 * Copies of a row or column selection are tagged so a later paste knows the
 * clipboard holds whole rows or columns rather than loose cell content.
 */
function writeCellSelectionToClipboard(
  view: EditorView,
  event: ClipboardEvent,
  axis: CellAxis,
) {
  if (!event.clipboardData) return false;

  const { dom, text } = view.serializeForClipboard(view.state.selection.content());
  dom.firstElementChild?.setAttribute(CELLS_CLIPBOARD_ATTRIBUTE, axis);

  event.preventDefault();
  event.clipboardData.clearData();
  event.clipboardData.setData(CELLS_CLIPBOARD_MIME, axis);
  event.clipboardData.setData("text/html", dom.innerHTML);
  event.clipboardData.setData("text/plain", text);
  return true;
}

/**
 * Cutting removes the rows or columns themselves instead of only emptying their
 * cells, which is what ProseMirror's default cut does. Emptying the table out
 * entirely is not possible, so a whole-table selection drops the table.
 */
function cutCellSelection(view: EditorView, event: ClipboardEvent, axis: CellAxis) {
  if (!writeCellSelectionToClipboard(view, event, axis)) return false;

  const dispatch = view.dispatch.bind(view);
  const remove = axis === "rows" ? deleteRow : deleteColumn;
  if (!remove(view.state, dispatch)) deleteTable(view.state, dispatch);
  return true;
}

function clipboardAxis(event: ClipboardEvent): CellAxis | null {
  const data = event.clipboardData;
  if (!data) return null;

  const mime = data.getData(CELLS_CLIPBOARD_MIME);
  if (mime === "rows" || mime === "columns") return mime;

  // The attribute carries the axis through the OS clipboard, which drops
  // custom MIME types.
  const html = data.getData("text/html");
  const match = new RegExp(
    `<table\\b[^>]*\\b${CELLS_CLIPBOARD_ATTRIBUTE}="(rows|columns)"`,
    "i",
  ).exec(html);
  return (match?.[1] as CellAxis | undefined) ?? null;
}

/**
 * Pasting whole rows or columns inserts them after the ones the cursor sits on
 * instead of overwriting the cells it happens to cover.
 */
function pasteCellsAfterSelection(view: EditorView, event: ClipboardEvent, slice: Slice) {
  const axis = clipboardAxis(event);
  if (!axis || !isInTable(view.state)) return false;

  const pasted = pastedCells(slice);
  if (!pasted) return false;

  const rect = selectedRect(view.state);
  const rows = axis === "rows";
  const cells = clipCells(
    pasted,
    rows ? rect.map.width : pasted.width,
    rows ? pasted.height : rect.map.height,
  );
  const count = rows ? cells.height : cells.width;
  const insertAt = rows ? rect.bottom : rect.right;

  // Make room first: filling only grows the table past its last row or column,
  // so pasting into the middle would otherwise overwrite what follows. addRow
  // works on raw positions and so needs a rect for the current doc, while
  // addColumn maps its own positions and so needs the original one.
  const tr = view.state.tr;
  for (let i = 0; i < count; i++) {
    if (!rows) {
      addColumn(tr, rect, insertAt);
      continue;
    }

    const table = tr.doc.nodeAt(rect.tableStart - 1);
    if (!table) return false;
    addRow(tr, { ...rect, map: TableMap.get(table), table }, insertAt + i);
  }
  view.dispatch(tr);

  const target = rows
    ? { top: insertAt, bottom: insertAt + count, left: 0, right: rect.map.width }
    : { top: 0, bottom: rect.map.height, left: insertAt, right: insertAt + count };
  insertCells(view.state, view.dispatch.bind(view), rect.tableStart, target, cells);
  return true;
}

/**
 * Runs ahead of the table package's own clipboard handling, which is why it is
 * a separate extension: child extensions are registered before their parent.
 */
const TableCellClipboard = Extension.create({
  name: "tableCellClipboard",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            copy: (view, event) => {
              const axis = selectionAxis(view.state.selection);
              return axis
                ? writeCellSelectionToClipboard(view, event as ClipboardEvent, axis)
                : false;
            },
            cut: (view, event) => {
              const axis = selectionAxis(view.state.selection);
              return axis ? cutCellSelection(view, event as ClipboardEvent, axis) : false;
            },
          },
          handlePaste: (view, event, slice) =>
            pasteCellsAfterSelection(view, event, slice),
        },
      }),
    ];
  },
});

function selectedTable(state: EditorView["state"]): {
  node: Parameters<typeof canConvertToSpreadsheet>[0];
  pos: number;
} | null {
  const { selection } = state;
  if (selection instanceof NodeSelection && selection.node.type.name === "table") {
    return { node: selection.node, pos: selection.from };
  }
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "table") return { node, pos: $from.before(depth) };
  }
  return null;
}

function positionOfNode(doc: ProseMirrorNode, target: ProseMirrorNode): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (node === target) found = pos;
    return found === null;
  });
  return found;
}

export const TableEditing = Extension.create({
  name: "tableEditing",

  addExtensions() {
    // The table package supplies the editing behaviour — commands, the
    // tableEditing plugin, column resizing, and the Tab / Shift-Tab cell
    // navigation keymap. Its schema half is replaced with the shared spec
    // table, so the server serializes tables without it.
    return [
      Table.extend({
        ...nodeFromSpec("table"),

        addCommands() {
          return {
            ...this.parent?.(),
            insertSpreadsheetTable:
              (options = {}) =>
              ({ tr, dispatch, editor }) => {
                const table = createTable(
                  editor.schema,
                  options.rows ?? 6,
                  options.cols ?? 4,
                  true,
                );
                const spreadsheet = table.type.create(
                  { ...table.attrs, tableKind: SPREADSHEET_TABLE_KIND },
                  table.content,
                );
                if (dispatch) {
                  tr.replaceSelectionWith(spreadsheet);
                  const insertedAt = positionOfNode(tr.doc, spreadsheet);
                  if (insertedAt !== null) {
                    tr.setSelection(NodeSelection.create(tr.doc, insertedAt));
                  }
                  dispatch(tr.scrollIntoView());
                }
                return true;
              },
            convertTableToSpreadsheet:
              () =>
              ({ state, dispatch }) => {
                const table = selectedTable(state);
                if (!table || !canConvertToSpreadsheet(table.node)) return false;
                if (dispatch) {
                  const tr = state.tr.setNodeMarkup(table.pos, undefined, {
                    ...table.node.attrs,
                    tableKind: SPREADSHEET_TABLE_KIND,
                  });
                  tr.setSelection(NodeSelection.create(tr.doc, table.pos));
                  dispatch(tr);
                }
                return true;
              },
          };
        },

        addNodeView() {
          const cellMinWidth = this.options.cellMinWidth;
          return ({ node, editor, getPos }) => {
            if (isSpreadsheetTable(node)) {
              return new SpreadsheetTableView(node, editor, getPos);
            }

            const table = new TableView(node, cellMinWidth);
            return {
              dom: table.dom,
              contentDOM: table.contentDOM,
              update(next) {
                if (isSpreadsheetTable(next)) return false;
                return table.update(next);
              },
              ignoreMutation: (mutation) => table.ignoreMutation(mutation),
            };
          };
        },
      }).configure({
        resizable: true,
      }),
      TableRow.extend(nodeFromSpec("tableRow")),
      TableHeader.extend(nodeFromSpec("tableHeader")),
      TableCell.extend(nodeFromSpec("tableCell")),
      TableCellClipboard,
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
