import { describe, expect, test } from "bun:test";
import { renderMessageMarkdown, tiptapJsonToMarkdown } from "#utils/messageMarkdown.ts";

describe("message markdown", () => {
  test("serializes minimal Tiptap formatting as markdown", () => {
    expect(
      tiptapJsonToMarkdown({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "important", marks: [{ type: "bold" }] }],
          },
          {
            type: "orderedList",
            attrs: { start: 1 },
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [
                      { type: "text", text: "first", marks: [{ type: "italic" }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe("**important**\n\n1. *first*");
  });

  test("serializes mentions without dropping their label", () => {
    expect(
      tiptapJsonToMarkdown({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Hello " },
              {
                type: "mention",
                attrs: { id: "jane@example.com", label: "Jane Doe" },
              },
            ],
          },
        ],
      }),
    ).toBe("Hello [@Jane Doe](mention:jane%40example.com)");
  });

  test("serializes mentions without an id as plain text", () => {
    expect(
      tiptapJsonToMarkdown({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Hello " },
              {
                type: "mention",
                attrs: { label: "Jane Doe" },
              },
            ],
          },
        ],
      }),
    ).toBe("Hello @Jane Doe");
  });

  test("renders mention links as user-mention elements", () => {
    const html = renderMessageMarkdown("[@Jane Doe](mention:jane%40example.com)");
    expect(html).toContain('<user-mention email="jane@example.com">');
    expect(html).toContain("Jane Doe</user-mention>");
  });

  test("renders formatting and blocks unsafe HTML and links", () => {
    const html = renderMessageMarkdown(
      "**safe** [unsafe](javascript:alert(1)) <script>alert(1)</script>",
    );

    expect(html).toContain("<strong>safe</strong>");
    expect(html).toContain('href="#"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
