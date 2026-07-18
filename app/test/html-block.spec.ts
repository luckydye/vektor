import { describe, expect, it } from "bun:test";
import { generateHTML, generateJSON } from "@tiptap/html";
import { contentExtensions } from "#editor/extensions.ts";

describe("HTML block parsing", () => {
  it("preserves unsupported block markup in an HTML block", () => {
    const json = generateJSON(
      '<section class="dashboard" style="color: red"><p>Dashboard</p></section>',
      contentExtensions(),
    );

    expect(json.content).toEqual([
      {
        type: "htmlBlock",
        attrs: {
          "data-html": '<section class="dashboard" style="color: red"><p>Dashboard</p></section>',
        },
      },
    ]);
  });

  it("round-trips table markup without parsing it as document content", () => {
    const source = '<table><tbody><tr><td style="text-align:right">117</td></tr></tbody></table>';
    const serialized = generateHTML(
      {
        type: "doc",
        content: [
          {
            type: "htmlBlock",
            attrs: { "data-html": source },
          },
        ],
      },
      contentExtensions(),
    );

    expect(serialized).toContain('data-html-encoding="uri"');
    expect(serialized).not.toContain("<tr>");
    expect(generateJSON(serialized, contentExtensions()).content).toEqual([
      {
        type: "htmlBlock",
        attrs: { "data-html": source },
      },
    ]);
  });
});
