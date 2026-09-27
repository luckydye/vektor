import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { htmlToDoc } from "#documents/schema/parse.ts";
import { docToYDoc } from "#documents/schema/yEncode.ts";
import { Collaboration } from "#editor/extensions/Collaboration.ts";
import { TrailingNodePlus } from "#editor/extensions/TrailingNodePlus.ts";
import { contentExtensions } from "#editor/extensions.ts";

/**
 * Opening a document must not edit it. An unpublished document opens straight
 * into edit mode, so whatever the editor writes to the shared Y.Doc reaches the
 * server as an edit and lands in the audit log as "edited".
 */

let editor: Editor | null = null;

function mountEditor(ydoc: Y.Doc): Editor {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...contentExtensions(),
      TrailingNodePlus.configure({ spaceId: "space_test" }),
      Collaboration.configure({ document: ydoc }),
    ],
  });
  return editor;
}

/**
 * The sync plugin only writes the editor state back to Yjs on a view update, so
 * a document the editor changed at mount reaches Yjs on the next interaction.
 * The real editor focuses itself as soon as it is created.
 */
function openWithoutEditing(ydoc: Y.Doc): Editor {
  const view = mountEditor(ydoc);
  view.commands.focus();
  return view;
}

/** Records the updates this client would send on, i.e. the ones it authored. */
function localUpdates(ydoc: Y.Doc): Uint8Array[] {
  const updates: Uint8Array[] = [];
  ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote") updates.push(update);
  });
  return updates;
}

/** The room state the server sends on join, encoded the way it stores it. */
function serverState(html: string): Uint8Array {
  return Y.encodeStateAsUpdate(docToYDoc(htmlToDoc(html)));
}

function endsWithEmptyParagraph(view: Editor): boolean {
  const last = view.state.doc.lastChild;
  return last?.type.name === "paragraph" && last.content.size === 0;
}

function trailingButton(view: Editor): HTMLElement | null {
  return view.view.dom.querySelector<HTMLElement>(".trailing-node-plus-button");
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

describe("joining a collaborative room", () => {
  it("writes nothing when the room is synced before the editor mounts", () => {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, serverState("<p>Draft body</p>"), "remote");
    const updates = localUpdates(ydoc);

    openWithoutEditing(ydoc);

    expect(updates).toHaveLength(0);
  });

  it("writes nothing when the room syncs after the editor mounts", () => {
    const ydoc = new Y.Doc();
    const updates = localUpdates(ydoc);
    const view = mountEditor(ydoc);

    Y.applyUpdate(ydoc, serverState("<p>Draft body</p>"), "remote");
    view.commands.focus();

    expect(updates).toHaveLength(0);
  });

  it("writes nothing when the user types", () => {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, serverState("<p>Draft body</p>"), "remote");
    const view = openWithoutEditing(ydoc);

    view.commands.insertContentAt(view.state.doc.content.size - 1, "!");

    expect(view.state.doc.textContent).toBe("Draft body!");
    expect(endsWithEmptyParagraph(view)).toBe(false);
    expect(ydoc.getXmlFragment("default").length).toBe(1);
  });
});

describe("the trailing line", () => {
  it("is decoration, so it shows without a paragraph to hang it on", () => {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, serverState("<p>Draft body</p>"), "remote");
    const view = openWithoutEditing(ydoc);

    expect(trailingButton(view)).not.toBeNull();
    expect(endsWithEmptyParagraph(view)).toBe(false);
  });

  it("becomes a real paragraph when the user clicks it", () => {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, serverState("<p>Draft body</p>"), "remote");
    const view = openWithoutEditing(ydoc);

    trailingButton(view)?.click();

    expect(endsWithEmptyParagraph(view)).toBe(true);
    expect(view.state.selection.from).toBe(view.state.doc.content.size - 1);
    // Shared state like everything else, so it has to reach the room rather
    // than living only in this client's editor.
    expect(ydoc.getXmlFragment("default").length).toBe(2);
  });
});
