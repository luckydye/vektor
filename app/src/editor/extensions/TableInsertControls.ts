import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { addColumn, addRow, isInTable, selectedRect } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";
import { addIcon } from "#assets/icons.ts";
import { browserLang, createTranslator } from "#utils/lang.ts";
const t = createTranslator(browserLang());

// Append-a-column and append-a-row buttons pinned to the right and bottom edges
// of the table holding the selection. Unlike the reorder handles these are not
// hover-gated: focus is the whole condition, so the affordance is visible for as
// long as the caret is in the table.
//
// The toolbar's table menu inserts relative to the selected cell; these two only
// ever append at the end, which is the move that otherwise needs a trip to the
// last cell first.

type Axis = "col" | "row";

// Distance from the table edge to the button, and how thick the button is.
const EDGE_GAP = 6;
const THICKNESS = 14;

function focusedTable(view: EditorView): HTMLTableElement | null {
  const { $from } = view.state.selection;

  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.spec.tableRole !== "table") continue;

    const dom = view.nodeDOM($from.before(depth));
    if (!(dom instanceof HTMLElement)) return null;
    return dom instanceof HTMLTableElement ? dom : dom.querySelector("table");
  }

  return null;
}

export const TableInsertControls = Extension.create({
  name: "tableInsertControls",

  addProseMirrorPlugins() {
    const editor = this.editor;

    const button = (axis: Axis, label: string) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = `table-insert-control table-insert-control-${axis}`;
      // Out of the tab order: the toolbar's table menu is the keyboard route to
      // these commands, and a stop between two cells would be in the way.
      element.tabIndex = -1;
      element.setAttribute("aria-label", label);
      element.innerHTML = addIcon;
      element.style.display = "none";
      return element;
    };

    const colButton = button("col", t("Add a column at the end"));
    const rowButton = button("row", t("Add a row at the end"));

    let observed: HTMLTableElement | null = null;
    let animationFrame: number | null = null;

    return [
      new Plugin({
        view: (view) => {
          const parent = view.dom.parentElement;
          parent?.appendChild(colButton);
          parent?.appendChild(rowButton);

          const hide = () => {
            colButton.style.display = "none";
            rowButton.style.display = "none";
          };

          // A lambda so the observer can be declared before `place`, which
          // needs it to follow the focused table.
          const resizeObserver = new ResizeObserver(() => schedulePlace());

          const place = () => {
            const table = editor.isEditable ? focusedTable(view) : null;
            if (table !== observed) {
              if (observed) resizeObserver.unobserve(observed);
              if (table) resizeObserver.observe(table);
              observed = table;
            }
            if (!table) {
              hide();
              return;
            }

            const rect = table.getBoundingClientRect();
            // A table wider than its wrapper scrolls under it, so the buttons
            // follow the visible edge rather than the table's own.
            const clip = (
              table.closest(".tableWrapper") ?? table
            ).getBoundingClientRect();
            const left = Math.max(rect.left, clip.left);
            const right = Math.min(rect.right, clip.right);
            const top = Math.max(rect.top, clip.top);
            const bottom = Math.min(rect.bottom, clip.bottom);

            if (
              bottom <= top ||
              right <= left ||
              bottom < 0 ||
              top > window.innerHeight
            ) {
              hide();
              return;
            }

            colButton.style.display = "flex";
            colButton.style.left = `${right + EDGE_GAP}px`;
            colButton.style.top = `${top}px`;
            colButton.style.width = `${THICKNESS}px`;
            colButton.style.height = `${bottom - top}px`;

            rowButton.style.display = "flex";
            rowButton.style.left = `${left}px`;
            rowButton.style.top = `${bottom + EDGE_GAP}px`;
            rowButton.style.width = `${right - left}px`;
            rowButton.style.height = `${THICKNESS}px`;
          };

          const schedulePlace = () => {
            if (animationFrame !== null) return;
            animationFrame = requestAnimationFrame(() => {
              animationFrame = null;
              place();
            });
          };

          const insert = (axis: Axis) => (event: MouseEvent) => {
            event.preventDefault();
            const state = editor.state;
            if (!editor.isEditable || !isInTable(state)) return;

            const rect = selectedRect(state);
            view.dispatch(
              axis === "col"
                ? addColumn(state.tr, rect, rect.map.width)
                : addRow(state.tr, rect, rect.map.height),
            );
          };

          // The buttons sit outside the editable, so a plain click would blur it
          // and take the selection the commands read with it.
          const keepFocus = (event: PointerEvent) => event.preventDefault();

          const onColClick = insert("col");
          const onRowClick = insert("row");
          colButton.addEventListener("click", onColClick);
          rowButton.addEventListener("click", onRowClick);
          colButton.addEventListener("pointerdown", keepFocus);
          rowButton.addEventListener("pointerdown", keepFocus);
          window.addEventListener("scroll", schedulePlace, true);
          window.addEventListener("resize", schedulePlace);

          place();

          return {
            update: schedulePlace,
            destroy: () => {
              if (animationFrame !== null) cancelAnimationFrame(animationFrame);
              resizeObserver.disconnect();
              colButton.removeEventListener("click", onColClick);
              rowButton.removeEventListener("click", onRowClick);
              colButton.removeEventListener("pointerdown", keepFocus);
              rowButton.removeEventListener("pointerdown", keepFocus);
              window.removeEventListener("scroll", schedulePlace, true);
              window.removeEventListener("resize", schedulePlace);
              colButton.remove();
              rowButton.remove();
            },
          };
        },
      }),
    ];
  },
});
