import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { moveTableColumn, moveTableRow } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";

// Drag-to-reorder for the rows and columns of editable ProseMirror tables.
//
// Hovering a cell reveals a column handle above the column and a row handle to
// the left of the row. Dragging a handle shows a drop indicator at the nearest
// boundary and, on release, moves the whole column/row to that position.
//
// Reordering is delegated to prosemirror-tables' moveTableColumn/moveTableRow
// commands, which handle merged cells (colspan/rowspan) correctly.

type Axis = "col" | "row";

// How far a handle protrudes beyond the table edge into the gutter, and how far
// outside the table the pointer may stray before the handles are dismissed.
const HANDLE_PROTRUSION = 9;
const HANDLE_KEEP_MARGIN = 40;
// How far into the table (from its top/left edge) the cursor still counts as
// "near" the column/row handle. The column handle only shows near the top edge
// and the row handle only near the left edge — not anywhere over the table.
const HANDLE_EDGE_ZONE = 26;

type TableInfo = {
  node: ProseMirrorNode;
  pos: number;
  dom: HTMLTableElement;
};

function findTable(view: EditorView, el: HTMLElement): TableInfo | null {
  const dom = el.closest("table");
  if (!dom) return null;

  let pos: number;
  try {
    pos = view.posAtDOM(el, 0);
  } catch {
    return null;
  }

  const $pos = view.state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.spec.tableRole === "table") {
      return { node, pos: $pos.before(depth), dom };
    }
  }
  return null;
}

// Index of the column/row nearest the pointer (0 distance when inside it).
function nearestIndex(rects: DOMRect[], position: number, axis: Axis) {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    const lo = axis === "col" ? rect.left : rect.top;
    const hi = axis === "col" ? rect.right : rect.bottom;
    const distance = position < lo ? lo - position : position > hi ? position - hi : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

export const TableReorder = Extension.create({
  name: "tableReorder",

  addProseMirrorPlugins() {
    const editor = this.editor;
    const pluginKey = new PluginKey("tableReorder");

    const colHandle = document.createElement("div");
    colHandle.className = "table-reorder-handle table-reorder-handle-col";
    const rowHandle = document.createElement("div");
    rowHandle.className = "table-reorder-handle table-reorder-handle-row";
    const dropIndicator = document.createElement("div");
    dropIndicator.className = "table-reorder-drop-indicator";

    let current: TableInfo | null = null;
    let currentCol = -1;
    let currentRow = -1;
    let drag: { axis: Axis; from: number } | null = null;
    let animationFrame: number | null = null;
    let pendingPointer: { x: number; y: number } | null = null;

    const hideHandles = () => {
      colHandle.style.display = "none";
      rowHandle.style.display = "none";
    };

    const hideDropIndicator = () => {
      dropIndicator.style.display = "none";
    };

    const columnRects = (table: HTMLTableElement) => {
      const firstRow = table.rows[0];
      if (!firstRow) return [];
      return Array.from(firstRow.cells, (cell) => cell.getBoundingClientRect());
    };

    const rowRects = (table: HTMLTableElement) =>
      Array.from(table.rows, (row) => row.getBoundingClientRect());

    const positionHandles = (clientX: number, clientY: number) => {
      if (!current || drag) return;
      const cols = columnRects(current.dom);
      const rows = rowRects(current.dom);
      const col = cols[currentCol];
      const row = rows[currentRow];
      const tableRect = current.dom.getBoundingClientRect();

      // The column handle only appears near the top edge and the row handle only
      // near the left edge (each reachable from its gutter), not anywhere over
      // the table. They straddle the edge so there is no dead gap to slip
      // through when the cursor travels out to grab them.
      const nearTop =
        clientY >= tableRect.top - HANDLE_KEEP_MARGIN &&
        clientY <= tableRect.top + HANDLE_EDGE_ZONE;
      const nearLeft =
        clientX >= tableRect.left - HANDLE_KEEP_MARGIN &&
        clientX <= tableRect.left + HANDLE_EDGE_ZONE;

      if (col && nearTop) {
        colHandle.style.display = "block";
        colHandle.style.left = `${col.left}px`;
        colHandle.style.width = `${col.width}px`;
        colHandle.style.top = `${tableRect.top - HANDLE_PROTRUSION}px`;
      } else {
        colHandle.style.display = "none";
      }

      if (row && nearLeft) {
        rowHandle.style.display = "block";
        rowHandle.style.top = `${row.top}px`;
        rowHandle.style.height = `${row.height}px`;
        rowHandle.style.left = `${tableRect.left - HANDLE_PROTRUSION}px`;
      } else {
        rowHandle.style.display = "none";
      }
    };

    // Proximity detection: pick the table whose (margin-expanded) bounds contain
    // the pointer, then the column/row nearest the cursor — so the handles track
    // by distance and stay reachable out in the gutter, rather than needing a
    // hover directly over a cell.
    const processTablePointer = (view: EditorView, clientX: number, clientY: number) => {
      if (!editor.isEditable) {
        current = null;
        hideHandles();
        return;
      }

      let found: TableInfo | null = null;
      for (const dom of view.dom.querySelectorAll<HTMLTableElement>("table")) {
        const rect = dom.getBoundingClientRect();
        if (
          clientX >= rect.left - HANDLE_KEEP_MARGIN &&
          clientX <= rect.right + HANDLE_KEEP_MARGIN &&
          clientY >= rect.top - HANDLE_KEEP_MARGIN &&
          clientY <= rect.bottom + HANDLE_KEEP_MARGIN
        ) {
          // Resolve the table node from a cell (a cell's position lands inside
          // the table, so the tableRole ancestor walk finds it reliably).
          const cell = dom.querySelector<HTMLElement>("td, th");
          found = cell ? findTable(view, cell) : null;
          break;
        }
      }

      if (!found) {
        current = null;
        hideHandles();
        return;
      }

      current = found;
      currentCol = nearestIndex(columnRects(found.dom), clientX, "col");
      currentRow = nearestIndex(rowRects(found.dom), clientY, "row");
      positionHandles(clientX, clientY);
    };

    const applyReorder = (axis: Axis, from: number, to: number) => {
      if (!current || from === to) return;
      // A position inside the table so the command can resolve it; the actual
      // move is driven by the explicit from/to indices.
      const posInsideTable = current.pos + 1;
      const command =
        axis === "col"
          ? moveTableColumn({ from, to, pos: posInsideTable, select: false })
          : moveTableRow({ from, to, pos: posInsideTable, select: false });
      command(editor.state, editor.view.dispatch.bind(editor.view));
    };

    return [
      new Plugin({
        key: pluginKey,
        view: (view) => {
          const parent = view.dom.parentElement;
          parent?.appendChild(colHandle);
          parent?.appendChild(rowHandle);
          parent?.appendChild(dropIndicator);
          hideHandles();
          hideDropIndicator();

          // The target index for the move: the column/row the cursor is over.
          const dropTargetIndex = (event: PointerEvent) => {
            if (!current || !drag) return drag?.from ?? 0;
            const rects =
              drag.axis === "col" ? columnRects(current.dom) : rowRects(current.dom);
            if (!rects.length) return drag.from;
            const pos = drag.axis === "col" ? event.clientX : event.clientY;
            return nearestIndex(rects, pos, drag.axis);
          };

          const onPointerMoveDuringDrag = (event: PointerEvent) => {
            if (!drag || !current) return;
            const rects =
              drag.axis === "col" ? columnRects(current.dom) : rowRects(current.dom);
            const target = dropTargetIndex(event);
            const rect = rects[target];
            if (!rect) return;
            const tableRect = current.dom.getBoundingClientRect();

            dropIndicator.style.display = "block";
            if (drag.axis === "col") {
              const x = target >= drag.from ? rect.right : rect.left;
              dropIndicator.style.left = `${x - 1}px`;
              dropIndicator.style.top = `${tableRect.top}px`;
              dropIndicator.style.width = "2px";
              dropIndicator.style.height = `${tableRect.height}px`;
            } else {
              const y = target >= drag.from ? rect.bottom : rect.top;
              dropIndicator.style.top = `${y - 1}px`;
              dropIndicator.style.left = `${tableRect.left}px`;
              dropIndicator.style.height = "2px";
              dropIndicator.style.width = `${tableRect.width}px`;
            }
          };

          const endDrag = (event: PointerEvent) => {
            if (drag && current) {
              applyReorder(drag.axis, drag.from, dropTargetIndex(event));
            }

            drag = null;
            hideDropIndicator();
            document.removeEventListener("pointermove", onPointerMoveDuringDrag);
            document.removeEventListener("pointerup", endDrag);
            document.body.style.userSelect = "";
            view.dom.classList.remove("table-reorder-active");
          };

          const startDrag = (axis: Axis) => (event: PointerEvent) => {
            if (event.button !== 0 || !current || !editor.isEditable) return;
            event.preventDefault();
            drag = { axis, from: axis === "col" ? currentCol : currentRow };
            hideHandles();
            document.body.style.userSelect = "none";
            view.dom.classList.add("table-reorder-active");
            document.addEventListener("pointermove", onPointerMoveDuringDrag);
            document.addEventListener("pointerup", endDrag);
          };

          const onColDown = startDrag("col");
          const onRowDown = startDrag("row");
          colHandle.addEventListener("pointerdown", onColDown);
          rowHandle.addEventListener("pointerdown", onRowDown);

          // Track the pointer globally (the handles live in the gutter outside
          // the editor DOM) and resolve the nearest table/column/row by
          // proximity, throttled to one pass per frame.
          const onDocumentMouseMove = (event: MouseEvent) => {
            if (drag) return;
            pendingPointer = { x: event.clientX, y: event.clientY };
            if (animationFrame !== null) return;

            animationFrame = requestAnimationFrame(() => {
              animationFrame = null;
              if (!pendingPointer || drag) return;
              const { x, y } = pendingPointer;
              pendingPointer = null;
              processTablePointer(view, x, y);
            });
          };
          // Listen on the editor's root node (shadow root, or document when not
          // in a shadow tree) — the content and gutter both live inside it and
          // pointer moves there bubble up to it.
          const rootNode = view.dom.getRootNode() as Document | ShadowRoot;
          rootNode.addEventListener("mousemove", onDocumentMouseMove as EventListener, {
            passive: true,
          });

          const onScroll = () => {
            if (drag) hideDropIndicator();
            hideHandles();
            current = null;
          };
          window.addEventListener("scroll", onScroll, true);

          return {
            destroy: () => {
              if (animationFrame !== null) cancelAnimationFrame(animationFrame);
              colHandle.removeEventListener("pointerdown", onColDown);
              rowHandle.removeEventListener("pointerdown", onRowDown);
              rootNode.removeEventListener(
                "mousemove",
                onDocumentMouseMove as EventListener,
              );
              document.removeEventListener("pointermove", onPointerMoveDuringDrag);
              document.removeEventListener("pointerup", endDrag);
              window.removeEventListener("scroll", onScroll, true);
              colHandle.remove();
              rowHandle.remove();
              dropIndicator.remove();
            },
          };
        },
      }),
    ];
  },
});
