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

  it("wraps an added image in a media marker", () => {
    const base = "<p>Before.</p>";
    const revision = '<p>Before.</p><img src="/photo.jpg" alt="Photo">';

    const result = inlineHtmlDiff(base, revision);

    expect(result).toBe(
      '<p>Before.</p><ins class="diff-ins-media"><img src="/photo.jpg" alt="Photo"></ins>',
    );
  });

  it("wraps a removed image so it is shown as removed, not live", () => {
    const base = '<p>Before.</p><img src="/photo.jpg" alt="Photo">';
    const revision = "<p>Before.</p>";

    const result = inlineHtmlDiff(base, revision);

    expect(result).toContain(
      '<del class="diff-del-media"><img src="/photo.jpg" alt="Photo"></del>',
    );
  });

  it("marks an image src change as the old image removed and the new added", () => {
    const base = '<p>x</p><img src="/old.jpg" alt="A">';
    const revision = '<p>x</p><img src="/new.jpg" alt="A">';

    const result = inlineHtmlDiff(base, revision);

    expect(result).toContain(
      '<del class="diff-del-media"><img src="/old.jpg" alt="A"></del>',
    );
    expect(result).toContain(
      '<ins class="diff-ins-media"><img src="/new.jpg" alt="A"></ins>',
    );
    // No longer two live, unmarked <img> tags side by side.
    expect(result).not.toContain(
      '<img src="/old.jpg" alt="A"><img src="/new.jpg" alt="A">',
    );
  });

  it("wraps an added horizontal rule", () => {
    const result = inlineHtmlDiff("<p>a</p><p>b</p>", "<p>a</p><hr><p>b</p>");
    expect(result).toContain('<ins class="diff-ins-media"><hr></ins>');
  });

  it("marks text but not structural tags inside a removed block with an image", () => {
    const base = '<p>Keep</p><p>Gone <img src="/a.jpg"> text</p>';
    const revision = "<p>Keep</p>";

    const result = inlineHtmlDiff(base, revision);

    expect(result).toContain('<del class="diff-del">Gone</del>');
    expect(result).toContain('<del class="diff-del-media"><img src="/a.jpg"></del>');
    expect(result).not.toContain('<del class="diff-del"><p>');
  });

  it("does not tear a tag on a '>' inside a quoted attribute value", () => {
    const base = "<p>x</p>";
    const revision = '<p>x</p><img alt="a > b" src="/p.jpg">';

    const result = inlineHtmlDiff(base, revision);

    expect(result).toBe(
      '<p>x</p><ins class="diff-ins-media"><img alt="a > b" src="/p.jpg"></ins>',
    );
  });

  it("keeps an attribute with '>' intact when nearby text changes", () => {
    const base = '<p>See <a href="/go" title="a > b">old</a></p>';
    const revision = '<p>See <a href="/go" title="a > b">new</a></p>';

    const result = inlineHtmlDiff(base, revision);

    expect(result).toBe(
      '<p>See <a href="/go" title="a > b"><del class="diff-del">old</del>' +
        '<ins class="diff-ins">new</ins></a></p>',
    );
  });

  it("leaves content with '>' in an attribute unchanged when nothing differs", () => {
    const html = '<p><a href="/s?q=a>b">link</a></p>';
    expect(inlineHtmlDiff(html, html)).toBe(html);
  });

  it("keeps the space separating added words outside the marker", () => {
    const base = "<p>Lorem</p>";
    const revision = "<p>Lorem ipsum</p>";

    const result = inlineHtmlDiff(base, revision);

    // The joining space sits outside the marker so the highlight hugs the word.
    expect(result).toBe('<p>Lorem <ins class="diff-ins">ipsum</ins></p>');
  });
});
