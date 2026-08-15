import { type Change, diffWordsWithSpace } from "diff";
import type { EmailNotificationOutbox } from "#db/schema/space.ts";
import { getMentionContexts } from "#documents/mentions.ts";
import { escapeHtml, htmlToPlainText } from "#utils/html.ts";
import { renderMessageMarkdown } from "#utils/markdown.ts";

const PREVIEW_MAX_LENGTH = 700;
/** A recipient mentioned all over a document gets the first few spots, not all. */
const MENTION_QUOTE_LIMIT = 3;
const ACCESS_FOOTER = "You received this because you have access to this document.";
const MENTION_FOOTER = "You received this because you were mentioned.";
const EMAIL_FONT = 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
/** Marks where unchanged text was dropped between two pieces of one delta. */
const GAP = " … ";

function headerText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function excerpt(value: string, maxLength = PREVIEW_MAX_LENGTH): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

/**
 * Concatenate every added (or removed) run into one readable delta. The text
 * the runs were separated by is gone, so the runs cannot simply be joined:
 * without a separator the last and first words of two runs fuse into one
 * ("thisdoesnotwork"). Runs split by nothing but whitespace rejoin with a
 * space; a real dropped span becomes an ellipsis.
 */
function collectDelta(changes: Change[], kind: "added" | "removed"): string {
  const pieces: string[] = [];
  let separator = "";

  for (const change of changes) {
    if (!change[kind]) {
      // The counterpart side of a replacement carries no text of this side, so
      // it neither separates nor bridges the runs around it.
      if (change.added || change.removed) continue;
      if (!change.value.trim()) {
        if (!separator) separator = " ";
        continue;
      }
      // Unchanged punctuation with no whitespace joined one word rather than
      // separating two ("request" + "-" + "scoped"): keep it verbatim.
      separator =
        change.value.length <= 2 && !/\s/.test(change.value) ? change.value : GAP;
      continue;
    }

    const value = change.value.trim();
    if (!value) continue;
    if (pieces.length) pieces.push(separator);
    pieces.push(value);
    separator = "";
  }

  return pieces.join("");
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
  const published = htmlToPlainText(publishedContent ?? "");
  if (!published) return null;

  if (previousContent === null || previousContent === undefined) {
    return { added: "", removed: "", published: excerpt(published) };
  }

  const previous = htmlToPlainText(previousContent);
  const changes = diffWordsWithSpace(previous, published);
  const added = excerpt(collectDelta(changes, "added"));
  const removed = excerpt(collectDelta(changes, "removed"));

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

/** The passages that mention this recipient, in document order. */
function mentionQuotes(
  html: string | null | undefined,
  recipientEmail: string | null | undefined,
): string[] {
  if (!html || !recipientEmail) return [];
  const contexts =
    getMentionContexts(html).get(recipientEmail.trim().toLowerCase()) ?? [];
  return contexts.slice(0, MENTION_QUOTE_LIMIT).map((context) => excerpt(context));
}

function mentionQuotesHtml(quotes: string[]): string {
  if (quotes.length === 0) return "";

  const blocks = quotes
    .map(
      (quote) =>
        `<div style="margin:0 0 8px;padding:12px 14px;border-left:3px solid #c099cf;border-radius:0 6px 6px 0;background:#f9f9f9;color:#3d3d3d;font:14px/22px ${EMAIL_FONT};white-space:pre-wrap;">${escapeHtml(quote)}</div>`,
    )
    .join("");

  return `
    <tr>
      <td style="padding:0 32px 24px;">
        <p style="margin:0 0 8px;color:#6e6e6e;font:600 12px/18px ${EMAIL_FONT};letter-spacing:.04em;text-transform:uppercase;">Where you were mentioned</p>
        ${blocks}
      </td>
    </tr>`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const firstInitial = parts[0]?.[0] ?? "?";
  return parts.length === 1 ? firstInitial : `${firstInitial}${parts.at(-1)?.[0] ?? ""}`;
}

function commentHtml(params: {
  actorName: string;
  actorImage?: string | null;
  comment: string;
}): string {
  const { actorName, comment } = params;
  const image = params.actorImage?.trim();
  const avatar = image
    ? `<img src="${escapeHtml(image)}" alt="" width="28" height="28" style="display:block;width:28px;height:28px;border-radius:50%;object-fit:cover;">`
    : `<table role="presentation" width="28" height="28" cellspacing="0" cellpadding="0" border="0" style="width:28px;height:28px;border-radius:50%;background:#d6bfde;"><tr><td align="center" valign="middle" style="height:28px;color:#78378f;font:700 11px/11px ${EMAIL_FONT};text-align:center;vertical-align:middle;">${escapeHtml(initials(actorName).toUpperCase())}</td></tr></table>`;

  return `<tr>
    <td style="padding:0 32px 24px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr>
          <td width="28" valign="top" style="padding:2px 10px 0 0;">${avatar}</td>
          <td valign="top"><p style="margin:0 0 3px;color:#141414;font:600 13px/18px ${EMAIL_FONT};">${escapeHtml(actorName)}</p><div style="color:#3d3d3d;font:14px/22px ${EMAIL_FONT};white-space:pre-wrap;">${escapeHtml(comment)}</div></td>
        </tr>
      </table>
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
  footer: string;
}): string {
  const {
    eyebrow,
    heading,
    message,
    documentTitle,
    spaceName,
    documentUrl,
    content,
    footer,
  } = params;
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
          <p style="margin:16px 0 0;color:#909090;font:12px/18px ${EMAIL_FONT};">${escapeHtml(footer)}</p>
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
  actorImage?: string | null;
  previousPublishedContent?: string | null;
  publishedContent?: string | null;
  /** Which mentions to quote — the recipient's own, not everybody else's. */
  recipientEmail?: string | null;
}): { subject: string; text: string; html: string } {
  const { notification, actorName, documentTitle, spaceName, documentUrl } = params;

  if (
    notification.kind === "comment_created" ||
    notification.kind === "comment_mention"
  ) {
    const mention = notification.kind === "comment_mention";
    // Comments are stored as markdown: rendering it first is what turns a
    // mention into the “@Name” the recipient wrote, not its link syntax.
    const comment = excerpt(
      htmlToPlainText(renderMessageMarkdown(params.commentContent ?? "")),
    );
    const subject = headerText(
      mention
        ? `${actorName} mentioned you in a comment on ${documentTitle}`
        : `${actorName} commented on ${documentTitle}`,
    );
    return {
      subject,
      text: [
        mention
          ? `${actorName} mentioned you in a comment on “${documentTitle}” in ${spaceName}.`
          : `${actorName} commented on “${documentTitle}” in ${spaceName}.`,
        comment ? `\n${comment}` : "",
        `\nOpen document: ${documentUrl}`,
      ].join("\n"),
      html: emailHtml({
        eyebrow: mention ? "Mention" : "New comment",
        heading: mention ? `${actorName} mentioned you` : `${actorName} commented`,
        message: mention
          ? `You were mentioned in a comment on this document.`
          : `A new comment was added to this document.`,
        documentTitle,
        spaceName,
        documentUrl,
        content: comment
          ? commentHtml({ actorName, actorImage: params.actorImage, comment })
          : "",
        footer: mention ? MENTION_FOOTER : ACCESS_FOOTER,
      }),
    };
  }

  if (notification.kind === "document_mention") {
    const quotes = mentionQuotes(params.publishedContent, params.recipientEmail);
    const subject = headerText(`${actorName} mentioned you in ${documentTitle}`);
    return {
      subject,
      text: [
        `${actorName} mentioned you in “${documentTitle}” in ${spaceName}.`,
        ...quotes.map((quote) => `\n${quote}`),
        `\nOpen document: ${documentUrl}`,
      ].join("\n"),
      html: emailHtml({
        eyebrow: "Mention",
        heading: `${actorName} mentioned you`,
        message: `You were mentioned in a published version of this document.`,
        documentTitle,
        spaceName,
        documentUrl,
        content: mentionQuotesHtml(quotes),
        footer: MENTION_FOOTER,
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
      footer: ACCESS_FOOTER,
    }),
  };
}
