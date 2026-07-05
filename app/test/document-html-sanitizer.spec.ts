import { describe, expect, it } from "bun:test";
import { sanitizeVektorDocumentPreviewHtml } from "#utils/documentHtmlSanitizer.ts";

describe("sanitizeVektorDocumentPreviewHtml", () => {
  it("removes executable markup from remote document previews", () => {
    const html = sanitizeVektorDocumentPreviewHtml(`
      <h1 onclick="alert(1)">Title</h1>
      <p style="background:url(https://evil.example)">Safe <strong>text</strong></p>
      <a href="javascript:alert(1)" target="_blank">bad link</a>
      <a href="https://example.com/page">good link</a>
      <img src="https://example.com/image.png" onerror="alert(1)" width="200">
      <script>alert(1)</script>
      <iframe src="https://evil.example"></iframe>
    `);

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>text</strong>");
    expect(html).toContain("<a>bad link</a>");
    expect(html).toContain(
      '<a href="https://example.com/page" rel="noopener noreferrer">good link</a>',
    );
    expect(html).toContain('<img src="https://example.com/image.png" width="200">');
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("style=");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
  });
});
