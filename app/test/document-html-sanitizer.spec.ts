import { describe, expect, it } from "vitest";
import {
  isSafeImageUrl,
  isSafeUploadedImageUrl,
  sanitizeDocumentHtml,
  sanitizeSvgMarkup,
  sanitizeVektorDocumentPreviewHtml,
} from "#utils/html.ts";

/** The payload an `html-block` carries, in the encoding the schema renders. */
function htmlBlock(payload: string): string {
  return `<html-block data-html-encoding="uri" data-html="${encodeURIComponent(payload)}"></html-block>`;
}

/** The `data-html` payload of a sanitized `html-block`, decoded. */
function htmlBlockPayload(html: string): string {
  const encoded = /data-html="([^"]*)"/.exec(html)?.[1] ?? "";
  return decodeURIComponent(encoded);
}

describe("sanitizeDocumentHtml", () => {
  it("removes the event handlers a script-only strip left behind", () => {
    const html = sanitizeDocumentHtml(
      '<p>x</p><img src="x" onerror="window.__img=1"><svg onload="window.__svg=1"><circle r="5"/></svg><p ONMOUSEOVER="alert(1)">y</p>',
    );

    expect(html).toContain("<p>x</p>");
    expect(html).toContain('<img src="x">');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onload");
    expect(html.toLowerCase()).not.toContain("onmouseover");
  });

  it("drops script, iframe, object, form and math subtrees", () => {
    const html = sanitizeDocumentHtml(
      "<script>window.__scr=1</script>" +
        '<iframe src="javascript:alert(1)"></iframe>' +
        '<object data="x"></object>' +
        '<form action="//evil"><input name="a"></form>' +
        "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></math>" +
        "<p>survives</p>",
    );

    expect(html).toBe("<p>survives</p>");
  });

  it("drops javascript: URLs and keeps the links a document stores", () => {
    const html = sanitizeDocumentHtml(
      '<p><a href="javascript:alert(1)">bad</a>' +
        '<a href="/docs" target="_blank" rel="noopener noreferrer nofollow">good</a></p>',
    );

    expect(html).toContain("<a>bad</a>");
    expect(html).toContain(
      '<a href="/docs" target="_blank" rel="noopener noreferrer nofollow">good</a>',
    );
    expect(html).not.toContain("javascript:");
  });

  it("rejects a javascript: URL hidden behind character references", () => {
    // A browser decodes the attribute before resolving it, so the sanitizer has
    // to judge the decoded value. Every one of these resolves to
    // `javascript:alert(1)` in a browser and executes when the link is clicked:
    // the semicolon is optional on a numeric reference, `&NewLine;` and `&Tab;`
    // insert characters the URL parser strips, and `&colon;` writes the `:`.
    const payloads = [
      "&#106;avascript:alert(1)",
      "&#106avascript:alert(1)",
      "java&NewLine;script:alert(1)",
      "java&Tab;script:alert(1)",
      "javascript&colon;alert(1)",
      "&#x6a;avascript:alert(1)",
    ];

    for (const payload of payloads) {
      expect(sanitizeDocumentHtml(`<a href="${payload}">x</a>`)).toBe("<a>x</a>");
      expect(sanitizeVektorDocumentPreviewHtml(`<a href="${payload}">x</a>`)).toBe(
        "<a>x</a>",
      );
    }
  });

  it("keeps the relative URLs and query strings a document links to", () => {
    // The rule that refuses the payloads above rejects a `&` in the region a
    // browser reads before it knows the value is relative. A query string's `&`
    // is past that point, and every one of these has to survive verbatim.
    const links = [
      "/docs/page",
      "/search?a=1&amp;b=2",
      "https://example.com/p?a=1&amp;b=2#frag",
      "mailto:a@b.c",
      "tel:+49123",
      "#section",
      "../up/one",
      "?query=only",
      "/a/b:c",
    ];

    for (const href of links) {
      expect(sanitizeDocumentHtml(`<a href="${href}">x</a>`)).toBe(
        `<a href="${href}">x</a>`,
      );
    }
  });

  it("drops an attribute whose name a browser reads differently than the parser", () => {
    // `html5parser` reports this attribute as `/onerror`, which an `on*` prefix
    // test does not catch, while a browser reads it as an `onerror` handler.
    const html = sanitizeDocumentHtml('<img/src="x"/onerror="alert(1)">');

    expect(html).toBe("<img>");
  });

  it("drops comments, including the abruptly-closed kind that hides markup", () => {
    // `<!-->` ends the comment for a browser, which then runs the `<img>`.
    const html = sanitizeDocumentHtml("<!--><img src=x onerror=alert(1)> -->");

    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<img");
  });

  it("drops style declarations that load a resource, keeping the rest", () => {
    const html = sanitizeDocumentHtml(
      '<p style="background:url(https://evil.example/track.png);text-align:right">t</p>',
    );

    expect(html).toBe('<p style="text-align:right;">t</p>');
  });

  it("drops a url() written with character references", () => {
    // The browser decodes the attribute before the CSS parser reads it, so
    // `&#117;rl(` is a `url()` — and its own semicolon splits the declaration
    // list, which is why decoding has to come before the split.
    for (const declaration of [
      "background-image:&#117;rl(//evil.example/x.png)",
      "background-image:url&#40;//evil.example/y.png)",
      "background-image:&#x75;rl(//evil.example/z.png)",
    ]) {
      const html = sanitizeDocumentHtml(`<p style="${declaration}">t</p>`);

      expect(html).toBe("<p>t</p>");
    }
  });

  it("keeps a declaration whose quoted value contains a semicolon", () => {
    // Splitting on every `;` cuts this declaration in half and leaves the
    // remains of its value as a declaration of its own.
    const html = sanitizeDocumentHtml(
      '<p style="background:url(x);font-family:&quot;A;B&quot;">t</p>',
    );

    expect(html).toBe('<p style="font-family:&quot;A;B&quot;;">t</p>');
  });

  it("stops at a nesting depth that would overflow the stack", () => {
    // The walker recurses per element and runs on every document write, so a
    // document nested this deep costs one save and must not throw.
    const deep = `${"<div>".repeat(50_000)}x${"</div>".repeat(50_000)}`;

    expect(() => sanitizeDocumentHtml(deep)).not.toThrow();
    expect(sanitizeDocumentHtml("<div><p>shallow</p></div>")).toBe(
      "<div><p>shallow</p></div>",
    );
  });

  it("sanitizes an html-block payload, which is re-rendered as markup", () => {
    const html = sanitizeDocumentHtml(
      htmlBlock(
        '<img src=x onerror="window.__hbxss++"><script>window.__hbscript=1</script>' +
          '<section class="dashboard" style="color: red"><p>Dashboard</p></section>',
      ),
    );

    const payload = htmlBlockPayload(html);
    expect(payload).not.toContain("onerror");
    expect(payload).not.toContain("<script");
    // The block exists to keep markup the schema has no node for, so what is
    // left of the payload has to survive verbatim.
    expect(payload).toContain(
      '<section class="dashboard" style="color: red"><p>Dashboard</p></section>',
    );
    expect(html).toContain('data-html-encoding="uri"');
  });

  it("sanitizes an unencoded html-block payload and stores it encoded", () => {
    const html = sanitizeDocumentHtml(
      '<html-block data-html="<img src=x onerror=alert(1)>"></html-block>',
    );

    expect(html).not.toContain("onerror");
    expect(htmlBlockPayload(html)).toBe('<img src="x">');
  });

  it("stops recursing into html-blocks nested inside html-blocks", () => {
    let payload = "<p>deep</p>";
    for (let level = 0; level < 8; level++) payload = htmlBlock(payload);

    expect(() => sanitizeDocumentHtml(payload)).not.toThrow();
  });

  it("leaves the markup the editor writes byte-identical", () => {
    // Sanitizing runs on write and on render, so anything it rewrites here it
    // rewrites in every stored document and in every revision diff.
    const documents = [
      '<p style="text-align: right;">t</p>',
      "<p>a &amp; b &nbsp; c</p>",
      '<pre><code class="language-js">&lt;div&gt;</code></pre>',
      "<p>first</p>\n<p>second</p>",
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label contenteditable="false"><input type="checkbox" checked></label><div><p>buy milk</p></div></li></ul>',
      '<table style="width: 200px"><colgroup><col style="width: 200px"></colgroup><tbody><tr><td colspan="2" style="background-color: #fff"><p>1</p></td></tr></tbody></table>',
      '<user-mention email="a@b.c" contenteditable="false">@a</user-mention>',
      '<div data-type="column-layout" data-columns="2"><div data-type="column-item"><p>a</p></div></div>',
      '<p><img src="/api/v1/spaces/space_1/files/file_1" alt="a" width="200"></p>',
    ];

    for (const document of documents) {
      expect(sanitizeDocumentHtml(document)).toBe(document);
    }
  });

  it("is idempotent", () => {
    const once = sanitizeDocumentHtml(
      '<p title="a &amp; b">x</p><img src=x onerror=alert(1)>' + htmlBlock("<p>in</p>"),
    );

    expect(sanitizeDocumentHtml(once)).toBe(once);
  });
});

describe("sanitizeSvgMarkup", () => {
  it("removes the handler a stored space logo can carry", () => {
    const svg = sanitizeSvgMarkup(
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">' +
        '<image href="x" onerror="window.__xss_fired=1" /></svg>',
    );

    expect(svg).not.toContain("onerror");
    // An external reference is dropped with it: a logo renders for every
    // member, so it must not become a request to a host it names.
    expect(svg).not.toContain('href="x"');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("drops script, foreignObject, style and the animation elements", () => {
    const svg = sanitizeSvgMarkup(
      "<svg><script>alert(1)</script>" +
        "<foreignObject><body><img src=x onerror=1></body></foreignObject>" +
        "<style>@import url(//evil)</style>" +
        '<set attributeName="onload" to="alert(1)"/>' +
        '<rect width="10" height="10"/></svg>',
    );

    expect(svg).toBe('<svg><rect width="10" height="10"></rect></svg>');
  });

  it("keeps internal references and drops external ones", () => {
    const svg = sanitizeSvgMarkup(
      '<svg><clipPath id="a"><path d="M0 0"/></clipPath>' +
        '<use xlink:href="#a"/><use href="https://evil.example/x.svg#a"/></svg>',
    );

    expect(svg).toContain('xlink:href="#a"');
    expect(svg).not.toContain("evil.example");
  });

  it("keeps the drawing vocabulary a logo needs", () => {
    const svg = sanitizeSvgMarkup(
      '<svg viewBox="0 0 24 24"><linearGradient id="g"><stop offset="0" stop-color="#fff"/>' +
        '</linearGradient><path d="M0 0h24v24H0z" fill="url(#g)"/></svg>',
    );

    expect(svg).toContain('d="M0 0h24v24H0z"');
    expect(svg).toContain('fill="url(#g)"');
    expect(svg).toContain('stop-color="#fff"');
  });

  it("returns nothing for a value that is not an SVG document", () => {
    expect(sanitizeSvgMarkup("<img src=x onerror=alert(1)>")).toBe("");
    expect(sanitizeSvgMarkup("https://example.com/logo.png")).toBe("");
    expect(sanitizeSvgMarkup("")).toBe("");
  });
});

describe("isSafeImageUrl", () => {
  it("accepts image sources and refuses script and inline markup", () => {
    expect(isSafeImageUrl("https://example.com/a.png")).toBe(true);
    expect(isSafeImageUrl("/api/v1/spaces/space_1/files/file_1")).toBe(true);
    expect(isSafeImageUrl("data:image/png;base64,AAA")).toBe(true);

    expect(isSafeImageUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeImageUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    // An inline SVG is markup, not pixels.
    expect(isSafeImageUrl("data:image/svg+xml,<svg onload=alert(1)>")).toBe(false);
    expect(isSafeImageUrl("java\nscript:alert(1)")).toBe(false);
    expect(isSafeImageUrl("&#106avascript:alert(1)")).toBe(false);
    expect(isSafeImageUrl("javascript&colon;alert(1)")).toBe(false);
  });

  it("allows SVG data URIs only for uploaded logos and icons", () => {
    const svg = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
    expect(isSafeImageUrl(svg)).toBe(false);
    expect(isSafeUploadedImageUrl(svg)).toBe(true);
  });
});

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
