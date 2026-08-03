import { getSchema } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { prosemirrorJSONToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { htmlToDoc } from "#documents/schema/parse.ts";
import { docToHtml } from "#documents/schema/render.ts";
import type { DocNode } from "#documents/schema/specs.ts";
import { applyDocToFragment } from "#documents/schema/yEncode.ts";
import { contentExtensions } from "#editor/extensions.ts";

/**
 * The content-model gate.
 *
 * `y-prosemirror`'s sync plugin does not report schema-invalid content — it
 * deletes the Y item that carries it. Anything the server writes that the
 * editor's schema would reject therefore disappears the moment a client opens
 * the room, with no error anywhere. So the invariant is not "the parser handles
 * these inputs" but "whatever comes out of it is a document ProseMirror
 * accepts", and it is checked against the real schema for input designed to be
 * as malformed as anything an agent or a paste could produce.
 */

const schema = getSchema(contentExtensions({ spaceId: "space_a", documentId: "doc_a" }));

function expectValid(doc: DocNode, context: string): void {
  expect(() => Node.fromJSON(schema, doc).check(), context).not.toThrow();
}

function encode(fill: (fragment: Y.XmlFragment) => void): Uint8Array {
  const ydoc = new Y.Doc();
  ydoc.clientID = 1;
  fill(ydoc.getXmlFragment("default"));
  return Y.encodeStateAsUpdate(ydoc);
}

// A small xorshift, so a failure is reproducible from the seed alone.
function random(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return Math.abs(state) / 2 ** 31;
  };
}

const TAGS = [
  "p",
  "h1",
  "h7",
  "div",
  "span",
  "ul",
  "ol",
  "li",
  "td",
  "tr",
  "table",
  "tbody",
  "blockquote",
  "pre",
  "code",
  "strong",
  "em",
  "br",
  "hr",
  "img",
  "figure",
  "user-mention",
  "html-block",
  "expression-cell",
  "date-picker",
  "script",
  "label",
];

const ATTRS = [
  "",
  ' data-type="taskList"',
  ' data-type="taskItem" data-checked="true"',
  ' style="text-align: center; margin-left: 6em"',
  ' class="language-ts"',
  ' colspan="2" colwidth="90,90"',
  ' src="/f/a.png"',
  ' email="a@b.de"',
  " start=4",
  ' data-columns="3"',
];

const TEXTS = ["", "x", "a & b < c", "  spaced  ", "line\nbreak", "😀 中文"];

function fuzzHtml(next: () => number, depth = 0): string {
  const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)] as T;
  if (depth > 3 || next() < 0.25) return pick(TEXTS);

  const parts: string[] = [];
  const children = Math.floor(next() * 3);
  for (let i = 0; i <= children; i++) parts.push(fuzzHtml(next, depth + 1));

  const tag = pick(TAGS);
  return `<${tag}${pick(ATTRS)}>${parts.join("")}</${tag}>`;
}

describe("document normalization", () => {
  it("produces schema-valid documents for fuzzed malformed HTML", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const next = random(seed);
      const html = Array.from({ length: 3 }, () => fuzzHtml(next)).join("");
      expectValid(htmlToDoc(html), `seed ${seed}: ${html}`);
    }
  });

  it("re-parses its own output to the same document", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const next = random(seed);
      const html = Array.from({ length: 3 }, () => fuzzHtml(next)).join("");
      const once = docToHtml(htmlToDoc(html));
      expect(docToHtml(htmlToDoc(once)), `seed ${seed}: ${html}`).toBe(once);
    }
  });

  it("encodes fuzzed documents exactly as y-prosemirror would", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = random(seed);
      const html = Array.from({ length: 3 }, () => fuzzHtml(next)).join("");
      const doc = htmlToDoc(html);
      const expected = encode((fragment) =>
        prosemirrorJSONToYXmlFragment(schema, doc, fragment),
      );
      const actual = encode((fragment) => applyDocToFragment(fragment, doc));
      expect(actual, `seed ${seed}: ${html}`).toEqual(expected);
    }
  });

  it("wraps bare inline content at a block position in a paragraph", () => {
    expect(htmlToDoc("hello <strong>world</strong>")).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { indent: 0, textAlign: "" },
          content: [
            { type: "text", text: "hello " },
            { type: "text", marks: [{ type: "bold" }], text: "world" },
          ],
        },
      ],
    });
  });

  it("gives a list item the leading paragraph its content model requires", () => {
    const doc = htmlToDoc("<ul><li><h2>head</h2></li></ul>");
    const item = doc.content?.[0]?.content?.[0];
    expect(item?.content?.map((child) => child.type)).toEqual(["paragraph", "heading"]);
    expectValid(doc, "list item with a leading heading");
  });

  it("wraps a stray table row in the table it belongs to", () => {
    const doc = htmlToDoc("<tr><td><p>x</p></td></tr>");
    expect(doc.content?.[0]?.type).toBe("table");
    expect(doc.content?.[0]?.content?.[0]?.type).toBe("tableRow");
    expectValid(doc, "stray table row");
  });

  /**
   * `prosemirror-tables` adds cell spans up to build its table map, so a span
   * that is a string or a zero corrupts the table instead of failing a check:
   * cells collide, `fixTables` strips spans and pads rows, and every table
   * interaction throws afterwards. A stored table carries its spans in the
   * markup, and a table damaged that way is stored with `colspan="0"`.
   */
  it("reads cell spans as positive integers", () => {
    const cells = (html: string) =>
      htmlToDoc(html).content?.[0]?.content?.[0]?.content?.map((cell) => cell.attrs);

    expect(
      cells('<table><tr><td colspan="2" rowspan="3"><p>x</p></td></tr></table>'),
    ).toEqual([expect.objectContaining({ colspan: 2, rowspan: 3 })]);
    expect(
      cells(
        '<table><tr><td colspan="0"><p>x</p></td><td colspan="nope"><p>y</p></td></tr></table>',
      ),
    ).toEqual([
      expect.objectContaining({ colspan: 1 }),
      expect.objectContaining({ colspan: 1 }),
    ]);
  });

  it("drops marks inside a code block", () => {
    const doc = htmlToDoc("<pre><code><strong>bold</strong> plain</code></pre>");
    expect(doc.content?.[0]?.content).toEqual([{ type: "text", text: "bold plain" }]);
  });

  it("coerces a heading level outside the configured range", () => {
    const doc: DocNode = {
      type: "doc",
      content: [{ type: "heading", attrs: { level: 9 }, content: [] }],
    };
    // Round-tripping through HTML is the path a stored document takes.
    expect(htmlToDoc(docToHtml(doc)).content?.[0]?.attrs?.level).toBe(1);
  });

  it("fills empty required content with an empty paragraph", () => {
    expect(htmlToDoc("")).toEqual({
      type: "doc",
      content: [{ type: "paragraph", attrs: { indent: 0, textAlign: "" } }],
    });
    expect(htmlToDoc("<ul></ul>").content?.[0]).toEqual({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", attrs: { indent: 0, textAlign: "" } }],
        },
      ],
    });
  });

  it("keeps unknown markup verbatim in an html block", () => {
    expect(htmlToDoc('<figure class="x"><figcaption>c</figcaption></figure>')).toEqual({
      type: "doc",
      content: [
        {
          type: "htmlBlock",
          attrs: {
            "data-html": '<figure class="x"><figcaption>c</figcaption></figure>',
          },
        },
      ],
    });
  });

  it("leaves unknown markup nested in a content node in place", () => {
    // The `<div>` here is a task item's content wrapper, not a root-level block.
    const doc = htmlToDoc(
      '<ul data-type="taskList"><li data-type="taskItem"><div><p>a</p></div></li></ul>',
    );
    const item = doc.content?.[0]?.content?.[0];
    expect(item?.content?.map((child) => child.type)).toEqual(["paragraph"]);
  });
});
