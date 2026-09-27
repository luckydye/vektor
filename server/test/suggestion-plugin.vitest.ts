import { Editor, Extension } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { Document, Paragraph, Text } from "#editor/extensions/baseExtensions.ts";
import {
  type SuggestionConfig,
  type SuggestionProps,
  suggestionPlugin,
} from "#editor/suggestion.ts";

/**
 * The trigger/query state machine behind every suggestion popup.
 *
 * The mention popup only ever runs it with `allowSpaces`, so the rules that
 * decide when a popup opens at all — and the lifecycle a renderer sees — are
 * covered here instead, against a recorder renderer.
 */

type Item = { id: string };

let editor: Editor | null = null;
let events: string[] = [];
let lastProps: SuggestionProps<Item> | null = null;
/** What the renderer claims from `onKeyDown`. */
let claimKeys = false;

function createEditor(config: SuggestionConfig<Item> = {}) {
  events = [];
  lastProps = null;
  claimKeys = false;

  const suggestion = Extension.create({
    name: "testSuggestion",
    addProseMirrorPlugins() {
      return [
        suggestionPlugin<Item>({
          editor: this.editor,
          items: ({ query }) => [{ id: query }],
          render: () => ({
            onStart: (props) => {
              events.push(`start:${props.query}`);
              lastProps = props;
            },
            onUpdate: (props) => {
              events.push(`update:${props.query}`);
              lastProps = props;
            },
            onExit: () => {
              events.push("exit");
              lastProps = null;
            },
            onKeyDown: () => claimKeys,
          }),
          ...config,
        }),
      ];
    },
  });

  editor = new Editor({
    element: document.createElement("div"),
    extensions: [Document, Paragraph, Text, suggestion],
  });
  return editor;
}

/** The plugin awaits `items` before calling the renderer. */
async function type(text: string) {
  editor?.commands.insertContent(text);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function pressKey(key: string) {
  const instance = editor;
  if (!instance) throw new Error("no editor");
  return instance.view.someProp("handleKeyDown", (handler) =>
    handler(instance.view, new KeyboardEvent("keydown", { key })),
  );
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("suggestion plugin", () => {
  it("opens on a trigger and follows the query as it is typed", async () => {
    createEditor();
    await type("hi @j");
    await type("o");

    expect(events).toEqual(["start:j", "update:jo"]);
  });

  it("ignores a trigger that does not start a word", async () => {
    createEditor();
    await type("mail me at me@example.com");

    expect(events).toEqual([]);
  });

  it("closes once the query would contain a space", async () => {
    createEditor();
    await type("@jo");
    await type(" ");

    expect(events).toEqual(["start:jo", "exit"]);
  });

  it("keeps matching across spaces when allowed", async () => {
    createEditor({ allowSpaces: true });
    await type("@jo");
    await type(" doe");

    expect(events).toEqual(["start:jo", "update:jo doe"]);
  });

  it("follows the newest trigger rather than reopening the first", async () => {
    createEditor({ allowSpaces: true });
    await type("@ann");
    await type(" @bo");

    expect(events).toEqual(["start:ann", "update:bo"]);
    expect(lastProps?.text).toBe("@bo");
  });

  it("closes when the caret leaves the match", async () => {
    const instance = createEditor();
    await type("hi @jo");

    instance.commands.setTextSelection(2);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual(["start:jo", "exit"]);
  });

  it("uses a custom trigger character", async () => {
    createEditor({ char: "/" });
    await type("/head");

    expect(events).toEqual(["start:head"]);
    expect(lastProps?.range).toEqual({ from: 1, to: 6 });
  });

  it("decorates the matched text so a popup can measure it", async () => {
    const instance = createEditor();
    await type("hi @jo");

    const decoration = instance.view.dom.querySelector("span.suggestion");
    expect(decoration?.textContent).toBe("@jo");
    expect(lastProps?.decorationNode).toBe(decoration);
  });

  it("offers keys to the renderer only while a suggestion is open", async () => {
    createEditor();
    claimKeys = true;

    expect(pressKey("ArrowDown")).toBeFalsy();

    await type("@jo");

    expect(pressKey("ArrowDown")).toBe(true);
  });

  it("closes on Escape when the renderer does not claim it", async () => {
    createEditor();
    await type("@jo");

    expect(pressKey("Escape")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual(["start:jo", "exit"]);
  });

  it("drops an items response that a later keystroke superseded", async () => {
    const resolvers: Array<() => void> = [];
    createEditor({
      items: ({ query }) =>
        new Promise((resolve) => {
          resolvers.push(() => resolve([{ id: query }]));
        }),
    });

    editor?.commands.insertContent("@a");
    editor?.commands.insertContent("b");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The second lookup answers first; the stale one must not open a popup
    // behind it, nor update one that was never started.
    resolvers[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolvers[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual(["start:ab"]);
  });
});
