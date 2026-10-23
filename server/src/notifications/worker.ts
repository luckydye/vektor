import { eq } from "drizzle-orm";
import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { config, getLocalOrigin } from "#config";
import { getAuthDb } from "#db/client/db.ts";
import { one } from "#db/client/query.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { user } from "#db/schema/auth.ts";
import type { EmailNotificationOutbox } from "#db/schema/space.ts";
import { getComment } from "#db/space/comments.ts";
import { getDocument } from "#db/space/documents.ts";
import { isEmailMuted } from "#db/space/emailNotificationPreferences.ts";
import {
  claimDueEmailNotifications,
  markEmailNotificationSent,
  markEmailNotificationSkipped,
  nextEmailNotificationAt,
  retryEmailNotification,
} from "#db/space/emailOutbox.ts";
import { getRevisionContent } from "#db/space/revisions.ts";
import { getSpace } from "#db/space/spaces.ts";
import { propertyValueToText } from "#documents/properties.ts";
import { isSerializedDocumentType } from "#documents/types.ts";
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";
import type { SpaceWork } from "#platform/spaceWork.ts";
import { isEmailDeliveryAvailable, sendEmail } from "./email.ts";
import { renderNotificationEmail } from "./render.ts";

function documentUrl(spaceSlug: string, documentSlug: string): string {
  const origin = config().SITE_URL || config().API_URL || getLocalOrigin();
  return new URL(
    `/${encodeURIComponent(spaceSlug)}/doc/${encodeURIComponent(documentSlug)}`,
    origin,
  ).toString();
}

function emailImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const origin = config().SITE_URL || config().API_URL || getLocalOrigin();
  try {
    const url = new URL(value, origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function deliver(
  platform: Platform,
  spaceId: string,
  notification: EmailNotificationOutbox,
): Promise<void> {
  const store = await openSpaceStore(platform, spaceId);
  if (await isEmailMuted(store, notification.recipientUserId, notification.documentId)) {
    await markEmailNotificationSkipped(store, notification.id, "Document muted");
    return;
  }

  try {
    await verifyAccess(
      platform,
      spaceId,
      { type: ResourceType.DOCUMENT, id: notification.documentId },
      notification.recipientUserId,
      Permission.VIEWER,
    );
  } catch {
    await markEmailNotificationSkipped(store, notification.id, "Document access revoked");
    return;
  }

  const authDb = getAuthDb(platform);
  const [recipient, actor, doc, space] = await Promise.all([
    one(
      authDb
        .select({ email: user.email, emailVerified: user.emailVerified })
        .from(user)
        .where(eq(user.id, notification.recipientUserId)),
    ),
    one(
      authDb
        .select({ name: user.name, email: user.email, image: user.image })
        .from(user)
        .where(eq(user.id, notification.actorId)),
    ),
    getDocument(await openSpaceStore(platform, spaceId), notification.documentId),
    getSpace(platform, spaceId),
  ]);

  if (!recipient?.email || !recipient.emailVerified) {
    await markEmailNotificationSkipped(store, notification.id, "No verified email");
    return;
  }
  if (!doc || !space) {
    await markEmailNotificationSkipped(store, notification.id, "Document unavailable");
    return;
  }

  const titleValue = doc.properties.title;
  const title = titleValue ? propertyValueToText(titleValue).trim() : doc.slug;
  // A comment email quotes the comment; a publication email quotes the revision
  // it announced — and diffs it against its predecessor unless it is a mention,
  // which quotes the passage the recipient's name is in instead.
  const aboutComment =
    notification.kind === "comment_created" || notification.kind === "comment_mention";
  const aboutPublication =
    notification.kind === "document_published" ||
    notification.kind === "document_mention";
  const publicationHasHtmlContent =
    aboutPublication && !isSerializedDocumentType(doc.type);
  const [commentRecord, publishedContent, previousPublishedContent] = await Promise.all([
    aboutComment ? getComment(store, notification.sourceId) : undefined,
    publicationHasHtmlContent && typeof notification.publishedRevision === "number"
      ? getRevisionContent(store, notification.documentId, notification.publishedRevision)
      : undefined,
    publicationHasHtmlContent &&
    notification.kind === "document_published" &&
    typeof notification.previousPublishedRevision === "number"
      ? getRevisionContent(
          store,
          notification.documentId,
          notification.previousPublishedRevision,
        )
      : undefined,
  ]);
  if (aboutComment && !commentRecord) {
    await markEmailNotificationSkipped(store, notification.id, "Comment unavailable");
    return;
  }

  const rendered = renderNotificationEmail({
    notification,
    actorName: actor?.name || actor?.email || "Someone",
    actorImage: emailImageUrl(actor?.image),
    documentTitle: title || "Untitled",
    spaceName: space.name,
    documentUrl: documentUrl(space.slug, doc.slug),
    commentContent: commentRecord?.content,
    previousPublishedContent,
    publishedContent,
    recipientEmail: recipient.email,
    brandColor: space.preferences?.brandColor,
  });
  await sendEmail(platform, { to: recipient.email, ...rendered });
  await markEmailNotificationSent(store, notification.id);
}

/** Deliver the space's due outbox rows; idle while delivery is not configured. */
export const emailNotificationWork: SpaceWork = {
  name: "email notifications",
  async run(store) {
    if (!isEmailDeliveryAvailable(store.platform)) return;
    for (const notification of await claimDueEmailNotifications(store)) {
      try {
        await deliver(store.platform, store.spaceId, notification);
      } catch (error) {
        await retryEmailNotification(store, notification, error);
        appLogger.warn("Email notification delivery failed", {
          error,
          spaceId: store.spaceId,
          notificationId: notification.id,
          attempts: notification.attempts + 1,
        });
      }
    }
  },
  nextAt: async (store) =>
    isEmailDeliveryAvailable(store.platform)
      ? await nextEmailNotificationAt(store)
      : null,
};
