import { Editor } from "@tiptap/core";
import type { Slice } from "@tiptap/pm/model";
import { CellSelection } from "@tiptap/pm/tables";
import { afterEach, describe, expect, it } from "vitest";
import { contentExtensions } from "#editor/extensions.ts";

/**
 * Cutting and pasting a whole row or column has to beat the table package's own
 * clipboard handling, which overwrites cell contents in place. That comes down
 * to plugin precedence, so it is worth a test rather than a reading of the code.
 */

let editor: Editor | null = null;

const TABLE = `<table><tbody>
  <tr><td><p>a1</p></td><td><p>b1</p></td></tr>
  <tr><td><p>a2</p></td><td><p>b2</p></td></tr>
  <tr><td><p>a3</p></td><td><p>b3</p></td></tr>
</tbody></table>`;

function mountEditor(): Editor {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: contentExtensions(),
    content: TABLE,
  });
  return editor;
}

function clipboardEvent(): ClipboardEvent {
  const store = new Map<string, string>();
  return {
    preventDefault: () => {},
    clipboardData: {
      getData: (type: string) => store.get(type) ?? "",
      setData: (type: string, value: string) => store.set(type, value),
      clearData: () => store.clear(),
    },
  } as unknown as ClipboardEvent;
}

/** Cell positions per row, in document order. */
function cellPositions(view: Editor) {
  const rows: number[][] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== "tableRow") return true;
    const cells: number[] = [];
    node.forEach((_cell, offset) => {
      cells.push(pos + 1 + offset);
    });
    rows.push(cells);
    return false;
  });
  return rows;
}

function grid(view: Editor) {
  return cellPositions(view).map((row) =>
    row.map((pos) => view.state.doc.nodeAt(pos)?.textContent ?? ""),
  );
}

function select(view: Editor, axis: "rows" | "columns", index: number) {
  const rows = cellPositions(view);
  const { doc } = view.state;
  const selection =
    axis === "rows"
      ? CellSelection.rowSelection(
          doc.resolve(rows[index][0]),
          doc.resolve(rows[index][rows[index].length - 1]),
        )
      : CellSelection.colSelection(
          doc.resolve(rows[0][index]),
          doc.resolve(rows[rows.length - 1][index]),
        );
  view.view.dispatch(view.state.tr.setSelection(selection));
}

function cut(view: Editor) {
  const slice = view.state.selection.content();
  const event = clipboardEvent();
  const handled = view.view.someProp("handleDOMEvents", (handlers) =>
    handlers.cut?.(view.view, event),
  );
  return { handled: handled ?? false, event, slice };
}

function paste(view: Editor, clipboard: { event: ClipboardEvent; slice: Slice }) {
  return (
    view.view.someProp("handlePaste", (handler) =>
      handler(view.view, clipboard.event, clipboard.slice),
    ) ?? false
  );
}

/** The caret in the first cell of the given row. */
function caretIn(view: Editor, row: number, column = 0) {
  view.commands.setTextSelection(cellPositions(view)[row][column] + 2);
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("table row and column clipboard", () => {
  it("cuts the row itself, not just its cell contents", () => {
    const view = mountEditor();
    select(view, "rows", 1);

    expect(cut(view).handled).toBe(true);

    expect(grid(view)).toEqual([
      ["a1", "b1"],
      ["a3", "b3"],
    ]);
  });

  it("cuts the column itself, not just its cell contents", () => {
    const view = mountEditor();
    select(view, "columns", 0);

    expect(cut(view).handled).toBe(true);

    expect(grid(view)).toEqual([["b1"], ["b2"], ["b3"]]);
  });

  it("drops the table when every row is cut", () => {
    const view = mountEditor();
    const rows = cellPositions(view);
    view.view.dispatch(
      view.state.tr.setSelection(
        CellSelection.create(view.state.doc, rows[0][0], rows[2][1]),
      ),
    );

    expect(cut(view).handled).toBe(true);

    expect(view.state.doc.textContent).toBe("");
  });

  it("pastes a row below the one the caret is in", () => {
    const view = mountEditor();
    select(view, "rows", 2);
    const clipboard = cut(view);
    caretIn(view, 0);

    expect(paste(view, clipboard)).toBe(true);

    expect(grid(view)).toEqual([
      ["a1", "b1"],
      ["a3", "b3"],
      ["a2", "b2"],
    ]);
  });

  it("pastes a column right of the one the caret is in", () => {
    const view = mountEditor();
    select(view, "columns", 1);
    const clipboard = cut(view);
    caretIn(view, 0);

    expect(paste(view, clipboard)).toBe(true);

    expect(grid(view)).toEqual([
      ["a1", "b1"],
      ["a2", "b2"],
      ["a3", "b3"],
    ]);
  });

  it("leaves a plain cell paste to the table package, which fills in place", () => {
    const view = mountEditor();
    caretIn(view, 0);
    view.view.dispatch(
      view.state.tr.setSelection(
        CellSelection.create(view.state.doc, cellPositions(view)[0][0]),
      ),
    );
    const clipboard = cut(view);

    expect(clipboard.handled).toBe(false);
    caretIn(view, 1);
    paste(view, clipboard);

    expect(grid(view)).toEqual([
      ["a1", "b1"],
      ["a1", "b2"],
      ["a3", "b3"],
    ]);
  });
});
