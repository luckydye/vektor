import type { EmailNotificationOutbox } from "#db/schema/space.ts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function excerpt(value: string, maxLength = 500): string {
  const compact = value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function headerText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function renderNotificationEmail(params: {
  notification: EmailNotificationOutbox;
  actorName: string;
  documentTitle: string;
  spaceName: string;
  documentUrl: string;
  commentContent?: string | null;
}): { subject: string; text: string; html: string } {
  const { notification, actorName, documentTitle, spaceName, documentUrl } = params;
  const safeActorName = escapeHtml(actorName);
  const safeDocumentTitle = escapeHtml(documentTitle);
  const safeSpaceName = escapeHtml(spaceName);
  const safeDocumentUrl = escapeHtml(documentUrl);

  if (notification.kind === "comment_created") {
    const comment = excerpt(params.commentContent ?? "");
    const subject = headerText(`${actorName} commented on ${documentTitle}`);
    const text = [
      `${actorName} commented on “${documentTitle}” in ${spaceName}.`,
      comment ? `\n${comment}` : "",
      `\nOpen document: ${documentUrl}`,
    ].join("\n");
    return {
      subject,
      text,
      html: `<p><strong>${safeActorName}</strong> commented on <strong>${safeDocumentTitle}</strong> in ${safeSpaceName}.</p>${comment ? `<blockquote>${escapeHtml(comment)}</blockquote>` : ""}<p><a href="${safeDocumentUrl}">Open document</a></p>`,
    };
  }

  const subject = headerText(`${actorName} published changes to ${documentTitle}`);
  return {
    subject,
    text: `${actorName} published changes to “${documentTitle}” in ${spaceName}.\n\nOpen document: ${documentUrl}`,
    html: `<p><strong>${safeActorName}</strong> published changes to <strong>${safeDocumentTitle}</strong> in ${safeSpaceName}.</p><p><a href="${safeDocumentUrl}">Open document</a></p>`,
  };
}
