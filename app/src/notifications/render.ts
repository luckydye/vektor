import { diffWordsWithSpace } from "diff";
import type { EmailNotificationOutbox } from "#db/schema/space.ts";
import { escapeHtml } from "#utils/html.ts";

const PREVIEW_MAX_LENGTH = 700;
const EMAIL_FONT = 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

function decodeCodePoint(value: string, radix: number, original: string): string {
  const codePoint = Number.parseInt(value, radix);
  return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : original;
}

function headerText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function excerpt(value: string, maxLength = PREVIEW_MAX_LENGTH): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

/** Turn document HTML into safe, readable text for an email preview. */
function documentText(html: string): string {
  const text = html
    .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/blockquote|\/pre)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ");

  return text
    .replace(/&#x([\da-f]+);/gi, (match, codePoint: string) =>
      decodeCodePoint(codePoint, 16, match),
    )
    .replace(/&#(\d+);/g, (match, codePoint: string) =>
      decodeCodePoint(codePoint, 10, match),
    )
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/gi, (_match, entity: string) => {
      const entities: Record<string, string> = {
        nbsp: " ",
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        "#39": "'",
      };
      return entities[entity.toLowerCase()] ?? _match;
    });
}

interface ChangePreview {
  added: string;
  removed: string;
  published: string;
}

function changePreview(
  previousContent: string | null | undefined,
  publishedContent: string | null | undefined,
): ChangePreview | null {
  const published = documentText(publishedContent ?? "");
  if (!published) return null;

  if (previousContent === null || previousContent === undefined) {
    return { added: "", removed: "", published: excerpt(published) };
  }

  const previous = documentText(previousContent);
  const changes = diffWordsWithSpace(previous, published);
  const added = excerpt(
    changes
      .filter((change) => change.added)
      .map((change) => change.value)
      .join(""),
  );
  const removed = excerpt(
    changes
      .filter((change) => change.removed)
      .map((change) => change.value)
      .join(""),
  );

  if (!added && !removed) return null;
  return { added, removed, published: "" };
}

function previewHtml(preview: ChangePreview | null): string {
  if (!preview) return "";

  if (preview.published) {
    return `
      <tr>
        <td style="padding:0 32px 24px;">
          <p style="margin:0 0 8px;color:#6e6e6e;font:600 12px/18px ${EMAIL_FONT};letter-spacing:.04em;text-transform:uppercase;">Published content</p>
          <div style="padding:14px 16px;border:1px solid #e8e8e8;border-radius:6px;background:#f9f9f9;color:#3d3d3d;font:14px/22px ${EMAIL_FONT};white-space:pre-wrap;">${escapeHtml(preview.published)}</div>
        </td>
      </tr>`;
  }

  const added = preview.added
    ? `<tr><td style="padding:0 0 12px;"><p style="margin:0 0 6px;color:#15803d;font:600 12px/18px ${EMAIL_FONT};letter-spacing:.04em;text-transform:uppercase;">Added</p><div style="padding:12px 14px;border:1px solid #bbf7d0;border-radius:6px;background:#f0fdf4;color:#166534;font:14px/22px ${EMAIL_FONT};white-space:pre-wrap;">${escapeHtml(preview.added)}</div></td></tr>`
    : "";
  const removed = preview.removed
    ? `<tr><td><p style="margin:0 0 6px;color:#b91c1c;font:600 12px/18px ${EMAIL_FONT};letter-spacing:.04em;text-transform:uppercase;">Removed</p><div style="padding:12px 14px;border:1px solid #fecaca;border-radius:6px;background:#fef2f2;color:#991b1b;font:14px/22px ${EMAIL_FONT};text-decoration:line-through;white-space:pre-wrap;">${escapeHtml(preview.removed)}</div></td></tr>`
    : "";

  return `
    <tr>
      <td style="padding:0 32px 24px;">
        <p style="margin:0 0 8px;color:#6e6e6e;font:600 12px/18px ${EMAIL_FONT};letter-spacing:.04em;text-transform:uppercase;">What changed</p>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${added}${removed}</table>
      </td>
    </tr>`;
}

function emailHtml(params: {
  eyebrow: string;
  heading: string;
  message: string;
  documentTitle: string;
  spaceName: string;
  documentUrl: string;
  content: string;
}): string {
  const { eyebrow, heading, message, documentTitle, spaceName, documentUrl, content } =
    params;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <title>${escapeHtml(heading)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f5f5;color:#141414;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f5f5;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e8e8e8;border-radius:8px;overflow:hidden;">
            <tr>
              <td style="padding:18px 32px;border-bottom:1px solid #e8e8e8;color:#78378f;font:700 17px/22px ${EMAIL_FONT};letter-spacing:-.02em;">vektor</td>
            </tr>
            <tr>
              <td style="padding:32px 32px 24px;">
                <p style="margin:0 0 8px;color:#78378f;font:600 12px/18px ${EMAIL_FONT};letter-spacing:.04em;text-transform:uppercase;">${escapeHtml(eyebrow)}</p>
                <h1 style="margin:0 0 10px;color:#141414;font:700 22px/30px ${EMAIL_FONT};letter-spacing:-.02em;">${escapeHtml(heading)}</h1>
                <p style="margin:0;color:#5a5a5a;font:14px/22px ${EMAIL_FONT};">${escapeHtml(message)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #e8e8e8;border-radius:6px;background:#f9f9f9;">
                  <tr><td style="padding:12px 14px;"><p style="margin:0;color:#292929;font:600 14px/20px ${EMAIL_FONT};">${escapeHtml(documentTitle)}</p><p style="margin:2px 0 0;color:#6e6e6e;font:12px/18px ${EMAIL_FONT};">${escapeHtml(spaceName)}</p></td></tr>
                </table>
              </td>
            </tr>
            ${content}
            <tr>
              <td style="padding:0 32px 32px;"><a href="${escapeHtml(documentUrl)}" style="display:inline-block;padding:9px 14px;border:1px solid #b686c8;border-radius:6px;background:#c099cf;color:#ffffff;font:600 14px/20px ${EMAIL_FONT};text-decoration:none;">Open document</a></td>
            </tr>
          </table>
          <p style="margin:16px 0 0;color:#909090;font:12px/18px ${EMAIL_FONT};">You received this because you have access to this document.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function renderNotificationEmail(params: {
  notification: EmailNotificationOutbox;
  actorName: string;
  documentTitle: string;
  spaceName: string;
  documentUrl: string;
  commentContent?: string | null;
  previousPublishedContent?: string | null;
  publishedContent?: string | null;
}): { subject: string; text: string; html: string } {
  const { notification, actorName, documentTitle, spaceName, documentUrl } = params;

  if (notification.kind === "comment_created") {
    const comment = excerpt(documentText(params.commentContent ?? ""));
    const subject = headerText(`${actorName} commented on ${documentTitle}`);
    return {
      subject,
      text: [
        `${actorName} commented on “${documentTitle}” in ${spaceName}.`,
        comment ? `\n${comment}` : "",
        `\nOpen document: ${documentUrl}`,
      ].join("\n"),
      html: emailHtml({
        eyebrow: "New comment",
        heading: `${actorName} commented`,
        message: `A new comment was added to this document.`,
        documentTitle,
        spaceName,
        documentUrl,
        content: comment
          ? `<tr><td style="padding:0 32px 24px;"><p style="margin:0 0 8px;color:#6e6e6e;font:600 12px/18px ${EMAIL_FONT};letter-spacing:.04em;text-transform:uppercase;">Comment</p><div style="padding:14px 16px;border:1px solid #e8e8e8;border-radius:6px;background:#f9f9f9;color:#3d3d3d;font:14px/22px ${EMAIL_FONT};white-space:pre-wrap;">${escapeHtml(comment)}</div></td></tr>`
          : "",
      }),
    };
  }

  const preview = changePreview(params.previousPublishedContent, params.publishedContent);
  const changeText = preview?.published
    ? `\n\nPublished content:\n${preview.published}`
    : [
        preview?.added ? `\n\nAdded:\n${preview.added}` : "",
        preview?.removed ? `\n\nRemoved:\n${preview.removed}` : "",
      ].join("");
  const subject = headerText(`${actorName} published changes to ${documentTitle}`);
  return {
    subject,
    text: `${actorName} published changes to “${documentTitle}” in ${spaceName}.${changeText}\n\nOpen document: ${documentUrl}`,
    html: emailHtml({
      eyebrow: "Document updated",
      heading: `${actorName} published changes`,
      message: `There is a new published version of this document.`,
      documentTitle,
      spaceName,
      documentUrl,
      content: previewHtml(preview),
    }),
  };
}
