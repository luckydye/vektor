import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { contentExtensions } from "#editor/extensions.ts";

/**
 * The controls append at the end of the table regardless of where the caret
 * sits — that is the whole point of them next to the toolbar's insert-here
 * commands. Their placement needs layout, so only the commands are covered.
 */

let editor: Editor | null = null;

const TABLE = `<table><tbody>
  <tr><th><p>Name</p></th><th><p>Role</p></th></tr>
  <tr><td><p>Ada</p></td><td><p>Engineer</p></td></tr>
</tbody></table>`;

function mountEditor(): Editor {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: contentExtensions(),
    content: TABLE,
  });
  return editor;
}

function control(view: Editor, axis: "col" | "row"): HTMLElement {
  const parent = view.view.dom.parentElement;
  const button = parent?.querySelector<HTMLElement>(`.table-insert-control-${axis}`);
  if (!button) throw new Error(`no ${axis} control`);
  return button;
}

function shape(view: Editor) {
  const table = view.state.doc.firstChild;
  return { rows: table?.childCount ?? 0, cells: table?.firstChild?.childCount ?? 0 };
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("table insert controls", () => {
  it("appends a column from a caret in the first one", () => {
    const view = mountEditor();
    view.commands.setTextSelection(3);
    expect(shape(view)).toEqual({ rows: 2, cells: 2 });

    control(view, "col").click();

    expect(shape(view)).toEqual({ rows: 2, cells: 3 });
  });

  it("appends a row from a caret in the first one", () => {
    const view = mountEditor();
    view.commands.setTextSelection(3);

    control(view, "row").click();

    expect(shape(view)).toEqual({ rows: 3, cells: 2 });
  });

  it("does nothing when the caret is outside a table", () => {
    const view = mountEditor();
    view.commands.insertContentAt(view.state.doc.content.size, "<p>After</p>");
    view.commands.setTextSelection(view.state.doc.content.size - 1);

    control(view, "col").click();
    control(view, "row").click();

    expect(shape(view)).toEqual({ rows: 2, cells: 2 });
  });

  it("takes the buttons down with the editor", () => {
    const view = mountEditor();
    const parent = view.view.dom.parentElement;

    view.destroy();
    editor = null;

    expect(parent?.querySelectorAll(".table-insert-control")).toHaveLength(0);
  });
});
