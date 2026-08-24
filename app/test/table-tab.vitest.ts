import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { contentExtensions } from "#editor/extensions.ts";

/**
 * Tab inside a table means "next cell", everywhere else it means indent. Both
 * bindings exist — the table package's and `BlockIndent`'s — and which one wins
 * comes down to keymap precedence plus each handler declining outside its own
 * context, so it is worth a test rather than a reading of the code.
 */

let editor: Editor | null = null;

function createEditor() {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: contentExtensions(),
  });
  return editor;
}

function press(editor: Editor, key: string, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key, shiftKey });
  return (
    editor.view.someProp("handleKeyDown", (handler) => handler(editor.view, event)) ??
    false
  );
}

function cellTexts(editor: Editor) {
  const texts: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
      texts.push(node.textContent);
    }
  });
  return texts;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("Tab in tables", () => {
  it("moves the caret to the next and previous cell", () => {
    const editor = createEditor();
    editor.commands.insertTable({ rows: 1, cols: 2, withHeaderRow: false });
    editor.commands.insertContent("a");

    expect(press(editor, "Tab")).toBe(true);
    editor.commands.insertContent("b");
    expect(cellTexts(editor)).toEqual(["a", "b"]);

    expect(press(editor, "Tab", true)).toBe(true);
    editor.commands.insertContent("!");
    expect(cellTexts(editor)[0]).toContain("!");
  });

  it("still inserts a literal tab outside a table", () => {
    const editor = createEditor();
    editor.commands.setContent("<p>a</p>");
    editor.commands.focus("end");

    expect(press(editor, "Tab")).toBe(true);
    expect(editor.state.doc.textContent).toBe("a\t");
  });
});
