import { describe, expect, it } from "bun:test";
import { inlineHtmlDiff } from "#utils/inlineHtmlDiff.ts";

describe("inlineHtmlDiff", () => {
  it("returns unchanged content verbatim when nothing differs", () => {
    const html = "<p>Lorem ipsum dolor sit amet.</p>";
    expect(inlineHtmlDiff(html, html)).toBe(html);
  });

  it("wraps replaced words inline while keeping block structure", () => {
    const base = "<p>Lorem ipsum dolor sit amet.</p>";
    const revision = "<p>Lorem ipsum consectetur sit amet.</p>";

    const result = inlineHtmlDiff(base, revision);

    expect(result).toContain('<del class="diff-del">dolor</del>');
    expect(result).toContain('<ins class="diff-ins">consectetur</ins>');
    // Block structure is preserved and markers stay inside the paragraph.
    expect(result.startsWith("<p>Lorem ipsum ")).toBe(true);
    expect(result.endsWith(" sit amet.</p>")).toBe(true);
  });

  it("marks purely added text", () => {
    const base = "<p>Lorem ipsum.</p>";
    const revision = "<p>Lorem ipsum. Sed nisi.</p>";

    const result = inlineHtmlDiff(base, revision);

    expect(result).toContain('<ins class="diff-ins">');
    expect(result).toContain("Sed nisi.");
    expect(result).not.toContain('<del class="diff-del">');
  });

  it("marks a removed paragraph without wrapping its tags", () => {
    const base = "<p>First.</p><p>Second.</p>";
    const revision = "<p>Second.</p>";

    const result = inlineHtmlDiff(base, revision);

    expect(result).toContain('<del class="diff-del">First.</del>');
    // <del> never wraps a block tag.
    expect(result).not.toContain('<del class="diff-del"><p>');
    expect(result).not.toContain("</p></del>");
    expect(result).toContain("<p>Second.</p>");
  });

  it("keeps the space separating added words outside the marker", () => {
    const base = "<p>Lorem</p>";
    const revision = "<p>Lorem ipsum</p>";

    const result = inlineHtmlDiff(base, revision);

    // The joining space sits outside the marker so the highlight hugs the word.
    expect(result).toBe('<p>Lorem <ins class="diff-ins">ipsum</ins></p>');
  });
});
