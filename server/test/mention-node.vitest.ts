import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { Document, Paragraph, Text } from "#editor/extensions/baseExtensions.ts";
import { Mentions } from "#editor/extensions/Mentions.ts";
import type { SuggestionProps } from "#editor/suggestion.ts";

/**
 * The `mention` node owns its suggestion wiring (it used to come from
 * `@tiptap/extension-mention`), so the plumbing between typing the trigger and
 * ending up with a node in the document is ours to keep working.
 *
 * The popup itself is not under test — `render` here only captures the props the
 * suggestion plugin hands out, which is the same `command` the real popup calls
 * when a person is picked.
 */

type MentionItem = { id: string; label: string };

let editor: Editor | null = null;
let suggestion: SuggestionProps<MentionItem> | null = null;

function createEditor() {
  suggestion = null;
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      Document,
      Paragraph,
      Text,
      Mentions.configure({
        suggestion: {
          items: () => [{ id: "jane@example.com", label: "Jane Doe" }],
          render: () => ({
            onStart: (props: SuggestionProps<MentionItem>) => {
              suggestion = props;
            },
            onUpdate: (props: SuggestionProps<MentionItem>) => {
              suggestion = props;
            },
            onExit: () => {
              suggestion = null;
            },
          }),
        },
      }),
    ],
  });
  return editor;
}

/** The suggestion plugin calls `onStart`/`onUpdate` from an async view update. */
async function typeText(text: string) {
  editor?.commands.insertContent(text);
  await Promise.resolve();
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  suggestion = null;
});

describe("mention node", () => {
  it("opens a suggestion for a typed trigger and reports the query", async () => {
    createEditor();
    await typeText("Hi @Ja");

    expect(suggestion?.query).toBe("Ja");
  });

  it("inserts the picked person as a mention followed by a space", async () => {
    const instance = createEditor();
    await typeText("Hi @Ja");

    suggestion?.command({ id: "jane@example.com", label: "Jane Doe" });

    expect(instance.getHTML()).toBe(
      '<p>Hi <user-mention email="jane@example.com">@Jane Doe</user-mention> </p>',
    );
  });

  it("keeps a single space when the query already had one after it", async () => {
    const instance = createEditor();
    await typeText("Hi @Ja there");
    // Back between "@Ja" and the space, which is where the trailing-space
    // handling in the insert command kicks in.
    instance.commands.setTextSelection(7);
    await Promise.resolve();

    suggestion?.command({ id: "jane@example.com", label: "Jane Doe" });

    expect(instance.getHTML()).toBe(
      '<p>Hi <user-mention email="jane@example.com">@Jane Doe</user-mention> there</p>',
    );
  });

  it("restores the trigger character when a mention is backspaced", async () => {
    const instance = createEditor();
    await typeText("Hi @Ja");
    suggestion?.command({ id: "jane@example.com", label: "Jane Doe" });
    // Right behind the node — one Backspace earlier than the caret the insert
    // left, which first has to eat the trailing space.
    let mentionEnd = 0;
    instance.state.doc.descendants((node, pos) => {
      if (node.type.name === "mention") mentionEnd = pos + node.nodeSize;
    });
    instance.commands.setTextSelection(mentionEnd);

    const handled = instance.view.someProp("handleKeyDown", (handler) =>
      handler(instance.view, new KeyboardEvent("keydown", { key: "Backspace" })),
    );

    expect(handled).toBe(true);
    expect(instance.getHTML()).toBe("<p>Hi @ </p>");
  });

  it("round-trips a mention through its HTML", () => {
    const instance = createEditor();
    instance.commands.setContent(
      '<p><user-mention email="jane@example.com">@Jane Doe</user-mention></p>',
    );

    expect(instance.state.doc.firstChild?.firstChild?.attrs).toMatchObject({
      id: "jane@example.com",
      label: "Jane Doe",
    });
  });
});
