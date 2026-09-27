import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { Document, Paragraph, Text } from "#editor/extensions/baseExtensions.ts";
import { ImageUpload } from "#editor/extensions/ImageUpload.ts";

/**
 * The image node's schema-level behaviour, which used to come from
 * `@tiptap/extension-image`: what parses into an image, what does not, and the
 * two ways one gets inserted.
 *
 * Uploading is not covered here — it needs real files and the upload manager.
 */

let editor: Editor | null = null;

function createEditor() {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [Document, Paragraph, Text, ImageUpload],
  });
  return editor;
}

function imageAttrs(instance: Editor) {
  const attrs: Record<string, unknown>[] = [];
  instance.state.doc.descendants((node) => {
    if (node.type.name === "image") attrs.push(node.attrs);
  });
  return attrs;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("image node", () => {
  it("parses an img element with its alt and title", () => {
    const instance = createEditor();
    instance.commands.setContent(
      '<img src="https://example.com/a.png" alt="A picture" title="Tooltip">',
    );

    expect(imageAttrs(instance)[0]).toMatchObject({
      src: "https://example.com/a.png",
      alt: "A picture",
      title: "Tooltip",
    });
  });

  it("refuses a data: source, which would inline the file into the document", () => {
    const instance = createEditor();
    instance.commands.setContent('<p><img src="data:image/png;base64,iVBORw0KGgo="></p>');

    expect(imageAttrs(instance)).toEqual([]);
  });

  it("round-trips a resized image through its HTML", () => {
    const instance = createEditor();
    instance.commands.setContent('<img src="https://example.com/a.png" width="320">');

    expect(imageAttrs(instance)[0]).toMatchObject({ width: "320" });
    expect(instance.getHTML()).toContain('width="320"');
  });

  it("renders the width the resize handle sets as a pixel style", () => {
    const instance = createEditor();
    instance.commands.setImage({ src: "https://example.com/a.png" });
    instance.commands.updateAttributes("image", { width: 320 });

    expect(instance.getHTML()).toContain("width: 320px");
  });

  it("inserts an image with setImage", () => {
    const instance = createEditor();
    instance.commands.setImage({ src: "https://example.com/a.png", alt: "A picture" });

    expect(imageAttrs(instance)[0]).toMatchObject({
      src: "https://example.com/a.png",
      alt: "A picture",
    });
  });

  it("turns typed markdown image syntax into an image", () => {
    const instance = createEditor();
    // The input rule fires on the closing paren, so the text has to arrive as
    // typed input rather than as inserted content.
    instance.commands.insertContent("![A picture](https://example.com/a.png");
    instance.view.someProp("handleTextInput", (handler) =>
      handler(
        instance.view,
        instance.state.selection.from,
        instance.state.selection.to,
        ")",
      ),
    );

    expect(imageAttrs(instance)[0]).toMatchObject({
      src: "https://example.com/a.png",
      alt: "A picture",
    });
  });

  it("keeps images out of inline positions", () => {
    const instance = createEditor();

    expect(instance.state.schema.nodes.image.isInline).toBe(false);
    expect(instance.state.schema.nodes.image.spec.draggable).toBe(true);
  });
});
