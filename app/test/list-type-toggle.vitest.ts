import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { contentExtensions } from "#editor/extensions.ts";

/**
 * Switching list type from the formatting toolbar. Bullet, ordered and task
 * lists take different item nodes, so a type switch has to rewrite the items
 * too — a list left holding the wrong item type is invalid content and the
 * command silently does nothing.
 *
 * The switch applies to the selected items, which means splitting the list
 * around them and joining back onto whatever list of the target type they end
 * up next to.
 */

let editor: Editor | null = null;

function createEditor(content: string) {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: contentExtensions(),
    content,
  });
  return editor;
}

function listShape(editor: Editor) {
  const shape: string[] = [];
  editor.state.doc.descendants((node) => {
    if (/^(bulletList|orderedList|taskList|listItem|taskItem)$/.test(node.type.name)) {
      shape.push(node.type.name);
    }
  });
  return shape;
}

function positionIn(editor: Editor, text: string) {
  let pos: number | null = null;
  editor.state.doc.descendants((node, nodePos) => {
    if (pos === null && node.isText && node.text === text) pos = nodePos + 1;
  });
  if (pos === null) throw new Error(`no text node "${text}"`);
  return pos;
}

function placeCaretIn(editor: Editor, text: string) {
  editor.commands.setTextSelection(positionIn(editor, text));
}

function selectFromTo(editor: Editor, fromText: string, toText: string) {
  editor.commands.setTextSelection({
    from: positionIn(editor, fromText),
    to: positionIn(editor, toText),
  });
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("list type toggles", () => {
  it("converts only the item the caret is in", () => {
    const editor = createEditor(
      "<ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul>",
    );
    placeCaretIn(editor, "two");

    expect(editor.commands.toggleTaskList()).toBe(true);

    expect(listShape(editor)).toEqual([
      "bulletList",
      "listItem",
      "taskList",
      "taskItem",
      "bulletList",
      "listItem",
    ]);
    expect(editor.state.doc.textContent).toBe("onetwothree");
    expect(editor.isActive("taskList")).toBe(true);
  });

  it("converts the whole list when the selection covers every item", () => {
    const editor = createEditor("<ul><li><p>one</p></li><li><p>two</p></li></ul>");
    selectFromTo(editor, "one", "two");

    expect(editor.commands.toggleTaskList()).toBe(true);

    expect(listShape(editor)).toEqual(["taskList", "taskItem", "taskItem"]);
    expect(editor.state.doc.textContent).toBe("onetwo");
  });

  /**
   * The document editor keeps an empty paragraph after the last block
   * (`TrailingNodePlus`), and `canJoin` says yes to joining a list onto an
   * empty node of any type — the join then throws and the toggle looks dead.
   */
  it("converts a list that is followed by an empty paragraph", () => {
    const editor = createEditor("<ul><li><p>one</p></li><li><p>two</p></li></ul><p></p>");
    selectFromTo(editor, "one", "two");

    expect(editor.commands.toggleTaskList()).toBe(true);

    expect(listShape(editor)).toEqual(["taskList", "taskItem", "taskItem"]);
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
  });

  it("converts a single item of a list followed by an empty paragraph", () => {
    const editor = createEditor("<ul><li><p>one</p></li><li><p>two</p></li></ul><p></p>");
    placeCaretIn(editor, "two");

    expect(editor.commands.toggleTaskList()).toBe(true);

    expect(listShape(editor)).toEqual(["bulletList", "listItem", "taskList", "taskItem"]);
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
  });

  it("converts the items a partial selection covers", () => {
    const editor = createEditor(
      "<ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul>",
    );
    selectFromTo(editor, "two", "three");

    expect(editor.commands.toggleTaskList()).toBe(true);

    expect(listShape(editor)).toEqual([
      "bulletList",
      "listItem",
      "taskList",
      "taskItem",
      "taskItem",
    ]);
  });

  it("joins the converted item onto an adjacent list of the same type", () => {
    const editor = createEditor(
      "<ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul>",
    );

    placeCaretIn(editor, "one");
    editor.commands.toggleTaskList();
    placeCaretIn(editor, "two");
    editor.commands.toggleTaskList();

    expect(listShape(editor)).toEqual([
      "taskList",
      "taskItem",
      "taskItem",
      "bulletList",
      "listItem",
    ]);
    expect(editor.state.doc.textContent).toBe("onetwothree");
  });

  it("keeps the numbering of the ordered items left behind", () => {
    const editor = createEditor(
      "<ol><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ol>",
    );
    placeCaretIn(editor, "two");

    expect(editor.commands.toggleTaskList()).toBe(true);

    const starts: number[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "orderedList") starts.push(node.attrs.start);
    });
    expect(starts).toEqual([1, 2]);
  });

  it("converts a task item back to a bullet or ordered item", () => {
    const editor = createEditor(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>one</p></li></ul>',
    );
    placeCaretIn(editor, "one");

    expect(editor.commands.toggleBulletList()).toBe(true);
    expect(listShape(editor)).toEqual(["bulletList", "listItem"]);

    expect(editor.commands.toggleOrderedList()).toBe(true);
    expect(listShape(editor)).toEqual(["orderedList", "listItem"]);

    expect(editor.commands.toggleTaskList()).toBe(true);
    expect(listShape(editor)).toEqual(["taskList", "taskItem"]);
    expect(editor.state.doc.textContent).toBe("one");
  });

  it("keeps the caret in the item it was in", () => {
    const editor = createEditor(
      "<ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul>",
    );
    placeCaretIn(editor, "two");

    editor.commands.toggleTaskList();

    expect(editor.state.selection.$anchor.parent.textContent).toBe("two");
    expect(editor.state.selection.$anchor.node(-1).type.name).toBe("taskItem");
  });

  it("converts only the innermost list, keeping the nested one intact", () => {
    const editor = createEditor(
      "<ul><li><p>outer</p><ul><li><p>inner</p></li></ul></li></ul>",
    );
    placeCaretIn(editor, "inner");

    expect(editor.commands.toggleTaskList()).toBe(true);

    expect(listShape(editor)).toEqual(["bulletList", "listItem", "taskList", "taskItem"]);
    expect(editor.state.doc.textContent).toBe("outerinner");
  });

  it("unwraps just the selected item when toggling the type it already is", () => {
    const editor = createEditor(
      '<ul data-type="taskList"><li data-type="taskItem"><p>one</p></li><li data-type="taskItem"><p>two</p></li></ul>',
    );
    placeCaretIn(editor, "two");

    expect(editor.commands.toggleTaskList()).toBe(true);

    expect(listShape(editor)).toEqual(["taskList", "taskItem"]);
    expect(editor.state.doc.textContent).toBe("onetwo");
  });

  it("converts the whole list on select-all", () => {
    const editor = createEditor("<ul><li><p>one</p></li><li><p>two</p></li></ul>");
    editor.commands.selectAll();

    expect(editor.commands.toggleTaskList()).toBe(true);

    expect(listShape(editor)).toEqual(["taskList", "taskItem", "taskItem"]);
    expect(editor.state.doc.textContent).toBe("onetwo");
  });

  it("converts every enclosed list on select-all", () => {
    const editor = createEditor(
      "<ul><li><p>one</p></li></ul><p>between</p><ol><li><p>two</p></li></ol>",
    );
    editor.commands.selectAll();

    expect(editor.commands.toggleTaskList()).toBe(true);

    expect(listShape(editor)).toEqual(["taskList", "taskItem", "taskList", "taskItem"]);
    expect(editor.state.doc.textContent).toBe("onebetweentwo");
  });

  it("unwraps the list on select-all when it is already that type", () => {
    const editor = createEditor(
      '<ul data-type="taskList"><li data-type="taskItem"><p>one</p></li><li data-type="taskItem"><p>two</p></li></ul>',
    );
    editor.commands.selectAll();

    expect(editor.commands.toggleTaskList()).toBe(true);

    expect(listShape(editor)).toEqual([]);
    expect(editor.state.doc.textContent).toBe("onetwo");
  });

  it("wraps a plain paragraph in a task list", () => {
    const editor = createEditor("<p>one</p>");
    placeCaretIn(editor, "one");

    expect(editor.commands.toggleTaskList()).toBe(true);

    expect(listShape(editor)).toEqual(["taskList", "taskItem"]);
  });
});
