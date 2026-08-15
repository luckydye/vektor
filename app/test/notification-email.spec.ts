import { describe, expect, it } from "vitest";
import type { EmailNotificationOutbox } from "#db/schema/space.ts";
import { renderNotificationEmail } from "#notifications/render.ts";
import { htmlToPlainText } from "#utils/html.ts";

function publishNotification(): EmailNotificationOutbox {
  const now = new Date(0);
  return {
    id: "n1",
    kind: "document_published",
    sourceId: "d1",
    documentId: "d1",
    publishedRevision: 2,
    previousPublishedRevision: 1,
    actorId: "u1",
    recipientUserId: "u2",
    status: "pending",
    attempts: 0,
    availableAt: now,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    sentAt: null,
  };
}

function publishedEmail(previous: string | null, published: string) {
  return renderNotificationEmail({
    notification: publishNotification(),
    actorName: "Ada Lovelace",
    documentTitle: "Locale handling",
    spaceName: "Engineering",
    documentUrl: "https://vektor.test/engineering/doc/locale-handling",
    previousPublishedContent: previous,
    publishedContent: published,
  });
}

describe("htmlToPlainText", () => {
  it("keeps attribute payloads out of the text", () => {
    // The `>` inside the attribute value is what defeats a `<[^>]*>` strip.
    const html =
      '<p>Before</p><canvas-element data-props=\'{"label":"a > b","n":1}\'>' +
      "<canvas-body><p>Sketch</p></canvas-body></canvas-element><p>After</p>";

    expect(htmlToPlainText(html)).toBe("Before\nSketch\nAfter");
  });

  it("drops comments, declarations and non-prose elements", () => {
    const html =
      "<!doctype html><p>Keep<!-- hidden > note -->me</p>" +
      "<style>p { content: '>' }</style><script>var a = 1 > 0;</script>";

    expect(htmlToPlainText(html)).toBe("Keepme");
  });

  it("breaks blocks onto their own lines and bullets list items", () => {
    expect(htmlToPlainText("<h1>Title</h1><ul><li>one</li><li>two</li></ul>")).toBe(
      "Title\n• one\n• two",
    );
    expect(htmlToPlainText("<p>a&nbsp;b<br>c</p>")).toBe("a b\nc");
  });

  it("decodes character references exactly once", () => {
    // `&lt;` is markup the author escaped; `&amp;lt;` is the literal text `&lt;`.
    expect(htmlToPlainText("<p>&lt;b&gt; and &amp;lt;b&amp;gt;</p>")).toBe(
      "<b> and &lt;b&gt;",
    );
    expect(htmlToPlainText("<p>&#x2014;&#8212;</p>")).toBe("——");
  });
});

describe("renderNotificationEmail: published changes", () => {
  it("separates the pieces of a delta instead of fusing words", () => {
    const rendered = publishedEmail(
      "<p>The locale is stored in a module-level variable.</p>",
      "<p>The locale is stored in a request-scoped injection.</p>",
    );

    expect(rendered.text).toContain("Added:\nrequest-scoped injection");
    expect(rendered.text).toContain("Removed:\nmodule-level variable");
  });

  it("marks where unchanged text was dropped between two changed runs", () => {
    const rendered = publishedEmail(
      "<p>Alpha one two three beta.</p>",
      "<p>Gamma one two three delta.</p>",
    );

    expect(rendered.text).toContain("Added:\nGamma … delta");
    expect(rendered.text).toContain("Removed:\nAlpha … beta");
  });

  it("keeps unchanged punctuation that joined one word rather than splitting it", () => {
    const rendered = publishedEmail(
      "<p>It is server-side.</p>",
      "<p>It is request-scoped.</p>",
    );

    expect(rendered.text).toContain("Added:\nrequest-scoped");
    expect(rendered.text).not.toContain("request … scoped");
  });

  it("escapes the delta once in the HTML body", () => {
    const rendered = publishedEmail("<p>Old</p>", "<p>Use &lt;slot&gt; here</p>");

    expect(rendered.html).toContain("&lt;slot&gt; here");
    expect(rendered.html).not.toContain("&amp;lt;slot");
  });

  it("previews the whole document on a first publish", () => {
    const rendered = publishedEmail(null, "<p>Brand new page.</p>");

    expect(rendered.text).toContain("Published content:\nBrand new page.");
    expect(rendered.html).toContain("Published content");
  });

  it("omits the preview when nothing readable changed", () => {
    const rendered = publishedEmail(
      '<p class="a">Same words.</p>',
      '<p class="b">Same words.</p>',
    );

    expect(rendered.text).not.toContain("Added:");
    expect(rendered.text).not.toContain("Removed:");
    expect(rendered.html).not.toContain("What changed");
  });

  it("subjects stay on a single header line", () => {
    const rendered = renderNotificationEmail({
      notification: publishNotification(),
      actorName: "Ada\r\nLovelace",
      documentTitle: "Locale\nhandling",
      spaceName: "Engineering",
      documentUrl: "https://vektor.test/engineering/doc/locale-handling",
      previousPublishedContent: "<p>a</p>",
      publishedContent: "<p>b</p>",
    });

    expect(rendered.subject).toBe("Ada Lovelace published changes to Locale handling");
  });
});

describe("renderNotificationEmail: comments", () => {
  it("renders the comment text without markup", () => {
    const rendered = renderNotificationEmail({
      notification: { ...publishNotification(), kind: "comment_created" },
      actorName: "Ada Lovelace",
      documentTitle: "Locale handling",
      spaceName: "Engineering",
      documentUrl: "https://vektor.test/engineering/doc/locale-handling",
      commentContent: "Try `inject()` — see [this](https://vektor.test/x).",
    });

    expect(rendered.text).toContain("Try inject() — see this.");
    expect(rendered.html).toContain("Try inject() — see this.");
    expect(rendered.html).toContain(">AL<");
  });
});

describe("renderNotificationEmail: mentions", () => {
  const mentionComment = "Can you look at this, [@Grace](mention:grace%40example.com)?";

  it("names the mention in a comment instead of announcing a comment", () => {
    const rendered = renderNotificationEmail({
      notification: { ...publishNotification(), kind: "comment_mention" },
      actorName: "Ada Lovelace",
      documentTitle: "Locale handling",
      spaceName: "Engineering",
      documentUrl: "https://vektor.test/engineering/doc/locale-handling",
      commentContent: mentionComment,
      recipientEmail: "grace@example.com",
    });

    expect(rendered.subject).toBe(
      "Ada Lovelace mentioned you in a comment on Locale handling",
    );
    // The mention reads as it was written, not as its markdown link syntax.
    expect(rendered.text).toContain("Can you look at this, @Grace?");
    expect(rendered.html).toContain("Can you look at this, @Grace?");
    expect(rendered.html).toContain("You received this because you were mentioned.");
  });

  it("quotes the passage of the document the recipient was mentioned in", () => {
    const rendered = renderNotificationEmail({
      notification: { ...publishNotification(), kind: "document_mention" },
      actorName: "Ada Lovelace",
      documentTitle: "Locale handling",
      spaceName: "Engineering",
      documentUrl: "https://vektor.test/engineering/doc/locale-handling",
      publishedContent:
        "<p>The locale is request-scoped.</p>" +
        '<p>Owner: <user-mention email="grace@example.com">@Grace Hopper</user-mention> ' +
        "signs off on the rollout.</p>",
      recipientEmail: "grace@example.com",
    });

    expect(rendered.subject).toBe("Ada Lovelace mentioned you in Locale handling");
    expect(rendered.text).toContain("Owner: @Grace Hopper signs off on the rollout.");
    expect(rendered.html).toContain("Where you were mentioned");
    expect(rendered.html).toContain("Owner: @Grace Hopper signs off on the rollout.");
    // Only the recipient's own mention is quoted back to them.
    expect(rendered.text).not.toContain("The locale is request-scoped.");
  });

  it("still sends when the mention has since moved out of the revision", () => {
    const rendered = renderNotificationEmail({
      notification: { ...publishNotification(), kind: "document_mention" },
      actorName: "Ada Lovelace",
      documentTitle: "Locale handling",
      spaceName: "Engineering",
      documentUrl: "https://vektor.test/engineering/doc/locale-handling",
      publishedContent: "<p>Nobody is mentioned here.</p>",
      recipientEmail: "grace@example.com",
    });

    expect(rendered.subject).toBe("Ada Lovelace mentioned you in Locale handling");
    expect(rendered.html).not.toContain("Where you were mentioned");
  });
});
