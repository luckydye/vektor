import { describe, expect, it } from "vitest";
import { normalizeDom } from "./normalize.ts";

/**
 * The normalizer is load-bearing: too aggressive and the tier 2 diff hides a
 * regression, too timid and it is 100% framework noise. These pin both edges —
 * what it must erase, and what it must never erase.
 */

function html(markup: string): Element {
  const host = document.createElement("div");
  host.innerHTML = markup;
  return host;
}

describe("normalizeDom erases framework noise", () => {
  it("drops Vue scope attributes and Solid hydration keys", () => {
    const vue = normalizeDom(html('<p data-v-1a2b3c class="x">Hi</p>'));
    const solid = normalizeDom(html('<p data-hk="s00001" class="x">Hi</p>'));
    expect(vue).toBe(solid);
    expect(vue).toContain('<p class="x">Hi</p>');
  });

  it("drops render-anchor comments from either framework", () => {
    const vue = normalizeDom(html("<div><!--v-if--><span>A</span><!----></div>"));
    const solid = normalizeDom(html("<div><!--$--><span>A</span><!--/--></div>"));
    expect(vue).toBe(solid);
  });

  it("sorts class tokens so compiler ordering stops mattering", () => {
    const a = normalizeDom(html('<b class="alpha beta gamma"></b>'));
    const b = normalizeDom(html('<b class="gamma alpha beta"></b>'));
    expect(a).toBe(b);
  });

  it("stabilises generated ids while keeping the pairing intact", () => {
    const first = normalizeDom(
      html('<label for="v-42">L</label><input id="v-42" aria-controls="v-99">'),
    );
    const second = normalizeDom(
      html('<label for="s-7">L</label><input id="s-7" aria-controls="s-8">'),
    );
    expect(first).toBe(second);
    // The pairing survives: `for` and `id` still resolve to the same token.
    expect(first).toContain('for="id-1"');
    expect(first).toContain('id="id-1"');
    expect(first).toContain('aria-controls="id-2"');
  });

  it("keeps ids the app deliberately targets", () => {
    expect(normalizeDom(html('<div id="toast-container"></div>'))).toContain(
      'id="toast-container"',
    );
  });

  it("placeholders dates, clock times, relative times and uuids", () => {
    const out = normalizeDom(
      html(
        "<p>Jan 15, 2024 at 03:42 PM — 5 minutes ago — " +
          "doc_1b4e28ba-2fa1-11d2-883f-0016d3cca427</p>",
      ),
    );
    expect(out).not.toMatch(/2024|03:42|5 minutes|1b4e28ba/);
    expect(out).toContain("«date»");
    expect(out).toContain("«time»");
    expect(out).toContain("«ago»");
    expect(out).toContain("«uuid»");
  });

  it("collapses whitespace so indentation changes are invisible", () => {
    const tight = normalizeDom(html("<div><span>A</span><span>B</span></div>"));
    const loose = normalizeDom(html("<div>\n  <span>A</span>\n  <span>B</span>\n</div>"));
    expect(tight).toBe(loose);
  });
});

describe("normalizeDom preserves real differences", () => {
  it("notices a dropped class", () => {
    expect(normalizeDom(html('<b class="a b"></b>'))).not.toBe(
      normalizeDom(html('<b class="a"></b>')),
    );
  });

  it("notices a lost attribute", () => {
    expect(normalizeDom(html('<input type="text" disabled>'))).not.toBe(
      normalizeDom(html('<input type="text">')),
    );
  });

  it("notices a changed role or accessible name", () => {
    expect(normalizeDom(html('<button aria-label="Close">x</button>'))).not.toBe(
      normalizeDom(html('<button aria-label="Dismiss">x</button>')),
    );
  });

  it("notices a missing element", () => {
    expect(normalizeDom(html("<ul><li>A</li><li>B</li></ul>"))).not.toBe(
      normalizeDom(html("<ul><li>A</li></ul>")),
    );
  });

  it("notices reordered siblings", () => {
    expect(normalizeDom(html("<ul><li>A</li><li>B</li></ul>"))).not.toBe(
      normalizeDom(html("<ul><li>B</li><li>A</li></ul>")),
    );
  });

  it("notices changed text that is not a date", () => {
    expect(normalizeDom(html("<p>Saved</p>"))).not.toBe(
      normalizeDom(html("<p>Discarded</p>")),
    );
  });

  it("does not merge two different generated ids into one", () => {
    // `for` and `aria-controls` pointing at different targets must stay different.
    expect(normalizeDom(html('<a for="x" aria-controls="y"></a>'))).not.toBe(
      normalizeDom(html('<a for="x" aria-controls="x"></a>')),
    );
  });
});
