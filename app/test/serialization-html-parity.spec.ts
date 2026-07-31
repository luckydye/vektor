import type { JSONContent } from "@tiptap/core";
import { generateHTML } from "@tiptap/html";
import { describe, expect, it } from "vitest";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import { docFromContent, toCleanHtml } from "#documents/serialization.ts";
import { contentExtensions } from "#editor/extensions.ts";

/**
 * `toCleanHtml` used to call `generateHTML` once per top-level block to get its
 * one-block-per-line output. Each call builds a schema, a DOMSerializer and a
 * happy-dom Window, so serializing a 4 MiB append-only log meant ~30k DOM
 * environments — ~14s and 8.8GB of RSS for a single round-trip, which
 * OOM-killed the server.
 *
 * It now serializes the document in one pass and re-splits the serializer's own
 * output on top-level boundaries. That output must stay byte-identical, because
 * it is what gets persisted: any drift would rewrite every stored document and
 * corrupt line-based edit operations. This test keeps the original algorithm
 * around and asserts the two agree.
 */

/** The original implementation, preserved verbatim as the reference. */
function toCleanHtmlPerBlock(
  doc: Y.Doc,
  extensions: ReturnType<typeof contentExtensions>,
): string {
  const json = yDocToProsemirrorJSON(doc, "default") as {
    type: string;
    content?: JSONContent[];
  };
  return (json.content ?? [])
    .map((node) =>
      generateHTML({ type: json.type, content: [node] }, extensions).replaceAll(
        ' xmlns="http://www.w3.org/1999/xhtml"',
        "",
      ),
    )
    .join("\n");
}

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
  blockquote: "<blockquote><p>quoted</p></blockquote>",
  "code block": '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>',
  "horizontal rule": "<p>above</p>\n<hr>\n<p>below</p>",
  table:
    "<table><tbody><tr><th><p>h1</p></th><th><p>h2</p></th></tr><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>",
  "link mark": '<p><a href="https://example.com/x?a=1&amp;b=2">link</a></p>',
  "hard break": "<p>line<br>break</p>",
  "html block":
    "<html-block data-html=%3Cp%3Eraw%3C%2Fp%3E data-html-encoding=uri></html-block>",
  "empty paragraphs": "<p></p>\n<p>after empty</p>",
  "attributes with quotes": '<p style="color: red">styled</p>',
  "mixed document":
    "<h1>Report</h1>\n<p>intro <strong>bold</strong></p>\n<ul><li><p>a</p></li></ul>\n<blockquote><p>q</p></blockquote>\n<hr>\n<p>end</p>",
};

describe("toCleanHtml parity with the per-block implementation", () => {
  for (const [name, html] of Object.entries(CASES)) {
    it(`matches for ${name}`, () => {
      const doc = docFromContent("space_a", "doc_a", null, html);
      const extensions = contentExtensions({
        spaceId: "space_a",
        documentId: "doc_a",
      });
      expect(toCleanHtml(doc, extensions)).toBe(toCleanHtmlPerBlock(doc, extensions));
    });
  }

  it("matches for an append-only log of many blocks", () => {
    const lines = Array.from(
      { length: 400 },
      (_, i) => `<p>2026-07-25T00:00:00Z rss=${i} conns=${i % 7} note=log line ${i}</p>`,
    ).join("\n");
    const doc = docFromContent("space_a", "doc_a", null, lines);
    const extensions = contentExtensions({ spaceId: "space_a", documentId: "doc_a" });
    expect(toCleanHtml(doc, extensions)).toBe(toCleanHtmlPerBlock(doc, extensions));
  });

  it("keeps one top-level block per line", () => {
    const html = "<h1>Title</h1>\n<p>one</p>\n<p>two</p>\n<hr>\n<p>three</p>";
    const doc = docFromContent("space_a", "doc_a", null, html);
    const out = toCleanHtml(doc, contentExtensions({ spaceId: "space_a" }));
    expect(out.split("\n")).toHaveLength(5);
    expect(out).toBe(html);
  });

  it("round-trips through parse without drifting", () => {
    const html = CASES["mixed document"] as string;
    const extensions = contentExtensions({ spaceId: "space_a", documentId: "doc_a" });
    const once = toCleanHtml(docFromContent("space_a", "doc_a", null, html), extensions);
    const twice = toCleanHtml(docFromContent("space_a", "doc_a", null, once), extensions);
    expect(twice).toBe(once);
  });

  it("matches for empty content (ProseMirror inserts one empty block)", () => {
    const doc = docFromContent("space_a", "doc_a", null, "");
    const extensions = contentExtensions({ spaceId: "space_a" });
    expect(toCleanHtml(doc, extensions)).toBe(toCleanHtmlPerBlock(doc, extensions));
  });

  it("returns an empty string when the fragment has no blocks at all", () => {
    const doc = new Y.Doc();
    doc.getXmlFragment("default");
    const extensions = contentExtensions({ spaceId: "space_a" });
    expect(toCleanHtml(doc, extensions)).toBe("");
    expect(toCleanHtml(doc, extensions)).toBe(toCleanHtmlPerBlock(doc, extensions));
  });

  it("serializes a large document without a per-block DOM blow-up", () => {
    // The old implementation built one happy-dom Window per block; 5k blocks
    // took tens of seconds. This is a smoke check that the cost is now linear
    // and fast enough to be nowhere near the pool's 60s request timeout.
    const lines = Array.from(
      { length: 5000 },
      (_, i) => `<p>metrics line ${i} rss=123456789 heap=987654 conns=42</p>`,
    ).join("\n");
    const doc = docFromContent("space_a", "doc_a", null, lines);
    const extensions = contentExtensions({ spaceId: "space_a", documentId: "doc_a" });

    const started = performance.now();
    const out = toCleanHtml(doc, extensions);
    const elapsedMs = performance.now() - started;

    expect(out.split("\n")).toHaveLength(5000);
    expect(elapsedMs).toBeLessThan(10_000);
  });
});
