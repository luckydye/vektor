import { describe, expect, it } from "vitest";
import { prepareDocumentContent } from "#documents/content.ts";

describe("document content preparation", () => {
  it("sanitizes HTML inputs", () => {
    expect(
      prepareDocumentContent('<p onclick="alert(1)">Safe</p>', "text/html"),
    ).toBe("<p>Safe</p>");
  });

  it("converts markdown inputs into stored HTML", () => {
    const markdown = prepareDocumentContent("# Heading", "text/markdown");
    expect(markdown).toContain("<h1>Heading</h1>");
  });

  it("uses HTML as the fallback for unknown content types", () => {
    expect(
      prepareDocumentContent('<p onclick="alert(1)">Safe</p>', "text/plain"),
    ).toBe("<p>Safe</p>");
  });

  it("does not let an application MIME type bypass sanitization", () => {
    expect(
      prepareDocumentContent(
        '<p onclick="alert(1)">Safe</p>',
        "application/vnd.wiki.app+html",
      ),
    ).toBe("<p>Safe</p>");
  });
});
