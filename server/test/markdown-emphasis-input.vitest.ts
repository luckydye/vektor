import type { Editor } from "@tiptap/core";
import { Editor as TiptapEditor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { contentExtensions } from "#editor/extensions.ts";

/**
 * Markdown emphasis typed into the editor: the closing delimiter turns the
 * text between the pair into the mark and takes both delimiters with it.
 *
 * Everything here goes through `handleTextInput` one character at a time, the
 * way a keystroke arrives, because the rules also have to *not* fire on the
 * half-typed states along the way — `**bold*` must stay literal text.
 */

let editor: Editor | null = null;

function typeText(text: string) {
  const active = editor;
  if (!active) throw new Error("no editor");
  for (const char of text) {
    const { from, to } = active.state.selection;
    const handled = active.view.someProp("handleTextInput", (handler) =>
      handler(active.view, from, to, char),
    );
    if (!handled) active.commands.insertContent(char);
  }
}

function typeInParagraph(text: string) {
  editor = new TiptapEditor({
    element: document.createElement("div"),
    extensions: contentExtensions(),
    content: "<p></p>",
  });
  editor.commands.focus("end");
  typeText(text);
  return editor.state.doc.firstChild?.toString() ?? "";
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("markdown emphasis input rules", () => {
  it("marks bold", () => {
    expect(typeInParagraph("**bold**")).toBe('paragraph(bold("bold"))');
  });

  it("marks bold with underscores", () => {
    expect(typeInParagraph("__bold__")).toBe('paragraph(bold("bold"))');
  });

  it("marks italic", () => {
    expect(typeInParagraph("*em*")).toBe('paragraph(italic("em"))');
  });

  it("marks italic with underscores", () => {
    expect(typeInParagraph("_em_")).toBe('paragraph(italic("em"))');
  });

  it("marks strikethrough", () => {
    expect(typeInParagraph("~~gone~~")).toBe('paragraph(strike("gone"))');
  });

  it("marks strikethrough with a single tilde", () => {
    expect(typeInParagraph("~gone~")).toBe('paragraph(strike("gone"))');
  });

  it("nests italic inside bold", () => {
    expect(typeInParagraph("**bold _em_**")).toBe(
      'paragraph(bold("bold "), bold(italic("em")))',
    );
  });

  it("marks bold and italic together", () => {
    expect(typeInParagraph("***both***")).toBe('paragraph(bold(italic("both")))');
  });

  it("marks bold and italic together with underscores", () => {
    expect(typeInParagraph("___both___")).toBe('paragraph(bold(italic("both")))');
  });

  it("leaves the text alone mid-word", () => {
    expect(typeInParagraph("snake_case_name")).toBe('paragraph("snake_case_name")');
  });

  it("leaves an unclosed delimiter alone", () => {
    expect(typeInParagraph("**bold*")).toBe('paragraph("**bold*")');
  });

  it("keeps text before the emphasis", () => {
    expect(typeInParagraph("say **it**")).toBe('paragraph("say ", bold("it"))');
  });
});
