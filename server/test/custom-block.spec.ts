import { generateHTML, generateJSON } from "@tiptap/html";
import { describe, expect, it } from "vitest";
import { contentExtensions } from "#editor/extensions.ts";

describe("custom block parsing", () => {
  it("preserves unsupported block markup in an html block", () => {
    const json = generateJSON(
      '<section class="dashboard" style="color: red"><p>Dashboard</p></section>',
      contentExtensions(),
    );

    expect(json.content).toEqual([
      {
        type: "customBlock",
        attrs: {
          blockType: "html",
          props: {
            html: '<section class="dashboard" style="color: red"><p>Dashboard</p></section>',
          },
        },
      },
    ]);
  });

  it("keeps a task item's content wrapper in the task item, not an HTML block", () => {
    const json = generateJSON(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>buy milk</p></div></li></ul>',
      contentExtensions(),
    );

    expect(json.content).toHaveLength(1);
    expect(json.content?.[0]?.type).toBe("taskList");
    // The <div><p>buy milk</p></div> wrapper must stay inside the task item as a
    // paragraph, not be hoisted into a sibling html block.
    expect(JSON.stringify(json)).not.toContain("customBlock");
    expect(JSON.stringify(json)).toContain("buy milk");
  });

  it("does not hoist unknown markup nested inside a list item", () => {
    const json = generateJSON("<ul><li><div>nested</div></li></ul>", contentExtensions());

    expect(JSON.stringify(json)).not.toContain("customBlock");
  });

  it("still hoists root-level unknown markup even after nested ones exist", () => {
    const json = generateJSON(
      "<ul><li>item</li></ul><div>root level</div>",
      contentExtensions(),
    );

    const types = json.content?.map((n) => n.type);
    expect(types).toContain("customBlock");
    expect(types).toContain("bulletList");
  });

  it("round-trips table markup without parsing it as document content", () => {
    const source =
      '<table><tbody><tr><td style="text-align:right">117</td></tr></tbody></table>';
    const serialized = generateHTML(
      {
        type: "doc",
        content: [
          {
            type: "customBlock",
            attrs: { blockType: "html", props: { html: source } },
          },
        ],
      },
      contentExtensions(),
    );

    expect(serialized).toContain('data-block="html"');
    expect(serialized).not.toContain("<tr>");
    expect(generateJSON(serialized, contentExtensions()).content).toEqual([
      {
        type: "customBlock",
        attrs: { blockType: "html", props: { html: source } },
      },
    ]);
  });

  it("round-trips an extension block's props", () => {
    const block = { type: "customBlock", attrs: { blockType: "acme.quote", props: { text: "<b>&", n: 1 } } };
    const serialized = generateHTML({ type: "doc", content: [block] }, contentExtensions());

    expect(serialized).toContain('data-block="acme.quote"');
    expect(generateJSON(serialized, contentExtensions()).content).toEqual([block]);
  });
});
