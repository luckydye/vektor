import { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";
import { yUndoPluginKey } from "y-prosemirror";
import * as Y from "yjs";
import { htmlToDoc } from "#documents/schema/parse.ts";
import { docToYDoc } from "#documents/schema/yEncode.ts";
import { Collaboration } from "#editor/extensions/Collaboration.ts";
import { contentExtensions } from "#editor/extensions.ts";

/**
 * History lives in the Yjs UndoManager, so the whole editor has to reach it
 * through one plugin key. A second ProseMirror↔Yjs binding in the bundle gives
 * out a key that looks right and resolves to nothing.
 */

let editor: Editor | null = null;

function mountEditor(): { editor: Editor; ydoc: Y.Doc } {
  const ydoc = new Y.Doc();
  Y.applyUpdate(
    ydoc,
    Y.encodeStateAsUpdate(docToYDoc(htmlToDoc("<p>Body</p>"))),
    "remote",
  );
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [...contentExtensions(), Collaboration.configure({ document: ydoc })],
  });
  return { editor, ydoc };
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("collaborative history", () => {
  it("is reachable through y-prosemirror's plugin key", () => {
    const { editor: view } = mountEditor();

    expect(yUndoPluginKey.getState(view.state)?.undoManager).toBeDefined();
  });

  it("takes back a local edit", () => {
    const { editor: view } = mountEditor();
    view.commands.insertContentAt(view.state.doc.content.size - 1, "!");
    expect(view.state.doc.textContent).toBe("Body!");

    view.chain().focus().undo().run();

    expect(view.state.doc.textContent).toBe("Body");
  });

  it("does nothing when there is nothing of the user's to undo", () => {
    const { editor: view } = mountEditor();

    expect(view.can().undo()).toBe(false);
    expect(view.can().redo()).toBe(false);
  });

  it("keeps recording after a plugin reconfigure", () => {
    const { editor: view } = mountEditor();
    view.commands.insertContentAt(view.state.doc.content.size - 1, "!");
    // Without this the two edits merge into one stack item and a single undo
    // takes back both, whether or not the manager survived.
    yUndoPluginKey.getState(view.state)?.undoManager.stopCapturing();

    // Rebuilds every plugin view, which tears down the UndoManager the
    // reconfigured plugin state keeps pointing at.
    view.registerPlugin(new Plugin({ key: new PluginKey("undoReconfigureProbe") }));
    view.commands.insertContentAt(view.state.doc.content.size - 1, "?");
    expect(view.state.doc.textContent).toBe("Body!?");

    view.chain().focus().undo().run();

    expect(view.state.doc.textContent).toBe("Body!");
  });
});
