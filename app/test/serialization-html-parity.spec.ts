import { getSchema } from "@tiptap/core";
import { generateHTML, generateJSON } from "@tiptap/html";
import { describe, expect, it } from "vitest";
import { prosemirrorJSONToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { htmlToDoc } from "#documents/schema/parse.ts";
import { docToHtml } from "#documents/schema/render.ts";
import { applyDocToFragment } from "#documents/schema/yEncode.ts";
import { docFromContent, toCleanHtml } from "#documents/serialization.ts";
import { contentExtensions } from "#editor/extensions.ts";

/**
 * The server no longer builds a ProseMirror schema to (de)serialize documents:
 * `#documents/schema` walks the shared spec table straight from HTML to a
 * `Y.XmlFragment` and back. TipTap stays here as the oracle it replaced.
 *
 * Three things have to agree, and the third is the one that matters:
 *
 *  - the parsed document tree, because that is where a wrong attribute shows up
 *    first and most legibly;
 *  - the serialized HTML, because that is what gets persisted — drift would
 *    rewrite every stored document and disturb line-based edit operations;
 *  - **the encoded Yjs state**, because that is what the editor's sync plugin
 *    reads. It does not reject invalid input, it *deletes* the offending items,
 *    so anything shaped differently here is silent data loss on the first
 *    client that opens the room. HTML round-tripping alone does not prove it.
 */

const extensions = contentExtensions({ spaceId: "space_a", documentId: "doc_a" });
const schema = getSchema(extensions);

const CASES: Record<string, string> = {
  "single paragraph": "<p>hello</p>",
  "several blocks": "<h1>Title</h1>\n<p>one</p>\n<p>two</p>",
  headings: "<h1>h1</h1>\n<h2>h2</h2>\n<h3>h3</h3>\n<h4>h4</h4>",
  "inline marks":
    "<p><strong>bold</strong> <em>em</em> <s>strike</s> <u>u</u> <code>code</code></p>",
  "escaped entities": "<p>a &amp; b &lt; c &gt; d &quot;q&quot; &amp;amp;</p>",
  "unicode and emoji": "<p>héllo — wörld 😀 中文</p>",
  "nested lists":
    "<ul><li><p>one</p><ul><li><p>nested</p></li></ul></li><li><p>two</p></li></ul>",
  "ordered list": "<ol><li><p>first</p></li><li><p>second</p></li></ol>",
  "ordered list with start": '<ol start="3"><li><p>x</p></li></ol>',
  blockquote: "<blockquote><p>quoted</p></blockquote>",
  "code block": '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>',
  "horizontal rule": "<p>above</p>\n<hr>\n<p>below</p>",
  table:
    "<table><tbody><tr><th><p>h1</p></th><th><p>h2</p></th></tr><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>",
  // The shape a table is *stored* as, spans and widths included — a table that
  // has been saved once is read back from this, not from bare `<td>`s.
  "table with spans":
    '<table style="width: 400px;"><colgroup><col style="width: 200px;"><col style="width: 200px;"></colgroup><tbody><tr><th colspan="2" rowspan="1" colwidth="200,200" style="width: 200px;"><p>h</p></th></tr><tr><td colspan="1" rowspan="1" colwidth="200" style="width: 200px;"><p>a</p></td><td colspan="1" rowspan="1" colwidth="200" style="width: 200px;"><p>b</p></td></tr></tbody></table>',
  "link mark": '<p><a href="https://example.com/x?a=1&amp;b=2">link</a></p>',
  "hard break": "<p>line<br>break</p>",
  "html block":
    "<html-block data-html=%3Cp%3Eraw%3C%2Fp%3E data-html-encoding=uri></html-block>",
  "unknown element": "<div class=x>raw</div>",
  "empty paragraphs": "<p></p>\n<p>after empty</p>",
  "attributes with quotes": '<p style="color: red">styled</p>',
  "mixed document":
    "<h1>Report</h1>\n<p>intro <strong>bold</strong></p>\n<ul><li><p>a</p></li></ul>\n<blockquote><p>q</p></blockquote>\n<hr>\n<p>end</p>",
  "task list":
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label contenteditable="false"><input type="checkbox" checked></label><div><p>done</p></div></li></ul>',
  "nested task list":
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label contenteditable="false"><input type="checkbox"></label><div><p>a</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label contenteditable="false"><input type="checkbox"></label><div><p>b</p></div></li></ul></div></li></ul>',
  mention: '<p><user-mention email="a@b.de">@Ann</user-mention></p>',
  "document mention":
    '<p><document-mention data-document-id="d1" data-href="/x">@Doc</document-mention></p>',
  image: '<p></p>\n<img src="/f/a.png" alt="a">',
  // TipTap types every attribute no extension parses itself, so a value that
  // reads as a number has to arrive as one here too.
  "numeric attribute values": '<p></p>\n<img src="/f/1.png" alt="42" title="7">',
  "sub and sup": "<p><sub>a</sub><sup>b</sup></p>",
  "text style": '<p><span style="color: red; background-color: blue">x</span></p>',
  "text align": '<p style="text-align: center">c</p>',
  indent: '<p style="margin-left: 4em">i</p>',
  "column layout":
    '<div data-type="column-layout" data-columns="2"><div data-type="column-item"><p>a</p></div><div data-type="column-item"><p>b</p></div></div>',
  "comment anchor": '<p><span data-comment-id="c1">x</span></p>',
  "ticket link": '<p><ticket-link data-ticket-id="AB-1">AB-1</ticket-link></p>',
  "date picker": '<p><date-picker data-date="2020-01-02">Jan</date-picker></p>',
  "figma embed":
    '<figma-embed data-figma-url="https://www.figma.com/file/a"></figma-embed>',
  "file attachment":
    '<file-attachment src="/f/a.pdf" filename="a.pdf"></file-attachment>',
  video: '<video src="/f/a.mp4"></video>',
  "extension view":
    '<extension-view-block data-extension-id="e" data-route-path="/r"></extension-view-block>',
  "expression cell":
    '<table><tbody><tr><td><p><expression-cell data-formula="=1+1">=1+1</expression-cell></p></td></tr></tbody></table>',
};

/**
 * A Y.Doc with a fixed client id, so two docs built from the same content
 * encode to the same bytes rather than merely to the same structure.
 */
function pinnedDoc(fill: (fragment: Y.XmlFragment) => void): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = 1;
  fill(doc.getXmlFragment("default"));
  return Y.encodeStateAsUpdate(doc);
}

describe("html ⇄ Y.XmlFragment parity with the editor schema", () => {
  for (const [name, html] of Object.entries(CASES)) {
    it(`parses ${name} to the same document`, () => {
      expect(htmlToDoc(html)).toEqual(generateJSON(html, extensions));
    });

    it(`serializes ${name} to the same HTML`, () => {
      const expected = generateHTML(
        generateJSON(html, extensions),
        extensions,
      ).replaceAll(' xmlns="http://www.w3.org/1999/xhtml"', "");
      expect(docToHtml(htmlToDoc(html)).replaceAll("\n", "")).toBe(expected);
    });

    it(`encodes ${name} to the same Yjs state`, () => {
      const expected = pinnedDoc((fragment) =>
        prosemirrorJSONToYXmlFragment(schema, generateJSON(html, extensions), fragment),
      );
      const actual = pinnedDoc((fragment) =>
        applyDocToFragment(fragment, htmlToDoc(html)),
      );
      expect(actual).toEqual(expected);
    });
  }
});

describe("toCleanHtml", () => {
  it("keeps one top-level block per line", () => {
    const html = "<h1>Title</h1>\n<p>one</p>\n<p>two</p>\n<hr>\n<p>three</p>";
    const out = toCleanHtml(docFromContent("html", html));
    expect(out.split("\n")).toHaveLength(5);
    expect(out).toBe(html);
  });

  it("round-trips through parse without drifting", () => {
    for (const [name, html] of Object.entries(CASES)) {
      const once = toCleanHtml(docFromContent("html", html));
      const twice = toCleanHtml(docFromContent("html", once));
      expect(twice, name).toBe(once);
    }
  });

  it("gives empty content the one empty block the schema requires", () => {
    expect(toCleanHtml(docFromContent("html", ""))).toBe("<p></p>");
  });

  it("returns an empty string when the fragment has no blocks at all", () => {
    const doc = new Y.Doc();
    doc.getXmlFragment("default");
    expect(toCleanHtml(doc)).toBe("");
  });

  it("serializes a large document without a per-block DOM blow-up", () => {
    // The pipeline this replaced built one happy-dom Window per block; 5k blocks
    // took tens of seconds and gigabytes. This is a smoke check that the cost is
    // linear and nowhere near the serialization pool's 60s request timeout.
    const lines = Array.from(
      { length: 5000 },
      (_, i) => `<p>metrics line ${i} rss=123456789 heap=987654 conns=42</p>`,
    ).join("\n");
    const doc = docFromContent("html", lines);

    const started = performance.now();
    const out = toCleanHtml(doc);
    const elapsedMs = performance.now() - started;

    expect(out.split("\n")).toHaveLength(5000);
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it("round-trips an append-only log of many blocks", () => {
    const lines = Array.from(
      { length: 400 },
      (_, i) => `<p>2026-07-25T00:00:00Z rss=${i} conns=${i % 7} note=log line ${i}</p>`,
    ).join("\n");
    expect(toCleanHtml(docFromContent("html", lines))).toBe(lines);
  });
});

describe("workflow source", () => {
  it("round-trips code through a single code block", () => {
    const code = "export default async function () {\n  return 1 < 2;\n}\n";
    const doc = docFromContent("source-code", code);
    const fragment = doc.getXmlFragment("default");
    expect(fragment.length).toBe(1);
    expect((fragment.get(0) as Y.XmlElement).nodeName).toBe("codeBlock");
    expect((fragment.get(0) as Y.XmlElement).getAttribute("language")).toBe("javascript");
    expect(toCleanHtml(doc)).toContain("language-javascript");
  });
});
