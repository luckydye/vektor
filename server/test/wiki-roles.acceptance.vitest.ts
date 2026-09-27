import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { htmlToDoc } from "#documents/schema/parse.ts";
import { docToHtml } from "#documents/schema/render.ts";
import { contentExtensions } from "#editor/extensions.ts";

/**
 * Browser-side half of the independent SV Wiki roles acceptance suite.
 * These checks instantiate the real editor extension set; they do not import
 * assertions, fixtures, or setup from another feature test.
 */

let editor: Editor | null = null;

function createEditor(content = "<p></p>") {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: contentExtensions({ spaceId: "acceptance-space", documentId: "doc" }),
    content,
  });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("SV Wiki roles — independent editor acceptance suite", () => {
  it("AT-16 PM-04: mentions retain the addressed person's email and label", () => {
    const html =
      '<p>Hallo <user-mention email="anna@example.com">@Anna</user-mention></p>';
    const rendered = docToHtml(htmlToDoc(html));
    expect(rendered).toContain("anna@example.com");
    expect(rendered).toContain("@Anna");
  });

  it("AT-17 PM-05: table cells preserve status colours", () => {
    const instance = createEditor(
      '<table><tbody><tr><td style="background-color: #fde047"><p>Offen</p></td><td style="background-color: #22c55e"><p>Fertig</p></td></tr></tbody></table>',
    );
    const html = instance.getHTML();
    expect(html).toContain("background-color: #fde047");
    expect(html).toContain("background-color: #22c55e");
  });

  it("AT-18 PM-08/PM-09/PM-10: headings, paragraphs, tables and checked tasks remain editable", () => {
    const instance = createEditor(
      [
        "<h2>Asset-Lieferungen</h2>",
        "<p>Text aus Word oder Docs</p>",
        "<table><tbody><tr><td><p>Motiv</p></td><td><p>Status</p></td></tr></tbody></table>",
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Hero geliefert</p></li></ul>',
      ].join(""),
    );
    const html = instance.getHTML();
    expect(html).toContain("<h2");
    expect(html).toContain("<table");
    expect(html).toContain('data-type="taskList"');
    expect(html).toContain('data-checked="true"');
  });

  it("AT-19 PM-16/PM-17: resized images and PDF attachments round-trip", () => {
    const instance = createEditor(
      [
        '<img src="/api/v1/spaces/acceptance-space/uploads/aa/image.png" width="320" alt="Moodboard">',
        '<file-attachment src="/api/v1/spaces/acceptance-space/uploads/bb/briefing.pdf" filename="briefing.pdf"></file-attachment>',
      ].join(""),
    );
    const html = instance.getHTML();
    expect(html).toContain("image.png");
    expect(html).toMatch(/width(?:=|:)['" ]*320/);
    expect(html).toContain("file-attachment");
    expect(html).toContain("briefing.pdf");
  });

  it("AT-20 PM-23: blocks can be arranged in multiple columns", () => {
    const instance = createEditor(
      '<div data-type="column-layout" data-columns="2"><div data-type="column-item"><p>Links</p></div><div data-type="column-item"><table><tbody><tr><td><p>Rechts</p></td></tr></tbody></table></div></div>',
    );
    const html = instance.getHTML();
    expect(html).toContain('data-type="column-layout"');
    expect(html).toContain('data-columns="2"');
    expect(html).toContain("<table");
  });

  it("AT-21 PM-27: Figma and video elements are first-class document nodes", () => {
    const instance = createEditor(
      [
        '<figma-embed data-figma-url="https://www.figma.com/design/ABC123/Test"></figma-embed>',
        '<video src="/api/v1/spaces/acceptance-space/uploads/cc/demo.mp4"></video>',
      ].join(""),
    );
    const html = instance.getHTML();
    expect(html).toContain("figma-embed");
    expect(html).toContain("https://www.figma.com/design/ABC123/Test");
    expect(html).toContain("<video");
    expect(html).toContain("demo.mp4");
  });
});
