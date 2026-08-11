import { eq } from "drizzle-orm";
import { verifyDocumentRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import { config, getLocalOrigin } from "#config";
import { listActiveSpaceIds } from "#db/auth/spaceIndex.ts";
import { getAuthDb } from "#db/client/db.ts";
import { user } from "#db/schema/auth.ts";
import type { EmailNotificationOutbox } from "#db/schema/space.ts";
import { getComment } from "#db/space/comments.ts";
import { getDocument } from "#db/space/documents.ts";
import { isEmailMuted } from "#db/space/emailNotificationPreferences.ts";
import {
  claimDueEmailNotifications,
  markEmailNotificationSent,
  markEmailNotificationSkipped,
  retryEmailNotification,
} from "#db/space/emailOutbox.ts";
import { getRevisionContent } from "#db/space/revisions.ts";
import { getSpace } from "#db/space/spaces.ts";
import { propertyValueToText } from "#documents/properties.ts";
import { appLogger } from "#observability/logger.ts";
import { isEmailDeliveryAvailable, sendEmail } from "./email.ts";
import { renderNotificationEmail } from "./render.ts";

const TICK_INTERVAL_MS = 15_000;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickInProgress = false;

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
  spaceId: string,
  notification: EmailNotificationOutbox,
): Promise<void> {
  if (
    await isEmailMuted(spaceId, notification.recipientUserId, notification.documentId)
  ) {
    await markEmailNotificationSkipped(spaceId, notification.id, "Document muted");
    return;
  }

  try {
    await verifyDocumentRole(
      spaceId,
      notification.documentId,
      notification.recipientUserId,
      Permission.VIEWER,
    );
  } catch {
    await markEmailNotificationSkipped(
      spaceId,
      notification.id,
      "Document access revoked",
    );
    return;
  }

  const authDb = getAuthDb();
  const [recipient, actor, doc, space] = await Promise.all([
    authDb
      .select({ email: user.email, emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.id, notification.recipientUserId))
      .get(),
    authDb
      .select({ name: user.name, email: user.email, image: user.image })
      .from(user)
      .where(eq(user.id, notification.actorId))
      .get(),
    getDocument(spaceId, notification.documentId),
    getSpace(spaceId),
  ]);

  if (!recipient?.email || !recipient.emailVerified) {
    await markEmailNotificationSkipped(spaceId, notification.id, "No verified email");
    return;
  }
  if (!doc || !space) {
    await markEmailNotificationSkipped(spaceId, notification.id, "Document unavailable");
    return;
  }

  const titleValue = doc.properties.title;
  const title = titleValue ? propertyValueToText(titleValue).trim() : doc.slug;
  const [commentRecord, publishedContent, previousPublishedContent] = await Promise.all([
    notification.kind === "comment_created"
      ? getComment(spaceId, notification.sourceId)
      : undefined,
    notification.kind === "document_published" &&
    typeof notification.publishedRevision === "number"
      ? getRevisionContent(
          spaceId,
          notification.documentId,
          notification.publishedRevision,
        )
      : undefined,
    notification.kind === "document_published" &&
    typeof notification.previousPublishedRevision === "number"
      ? getRevisionContent(
          spaceId,
          notification.documentId,
          notification.previousPublishedRevision,
        )
      : undefined,
  ]);
  if (notification.kind === "comment_created" && !commentRecord) {
    await markEmailNotificationSkipped(spaceId, notification.id, "Comment unavailable");
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
  });
  await sendEmail({ to: recipient.email, ...rendered });
  await markEmailNotificationSent(spaceId, notification.id);
}

async function tick(): Promise<void> {
  if (tickInProgress) return;
  tickInProgress = true;
  try {
    for (const spaceId of await listActiveSpaceIds()) {
      try {
        const due = await claimDueEmailNotifications(spaceId);
        for (const notification of due) {
          try {
            await deliver(spaceId, notification);
          } catch (error) {
            await retryEmailNotification(spaceId, notification, error);
            appLogger.warn("Email notification delivery failed", {
              error,
              spaceId,
              notificationId: notification.id,
              attempts: notification.attempts + 1,
            });
          }
        }
      } catch (error) {
        appLogger.error("Email notification tick failed for space", { error, spaceId });
      }
    }
  } catch (error) {
    appLogger.error("Email notification tick failed", { error });
  } finally {
    tickInProgress = false;
  }
}

export function startEmailNotificationWorker(): void {
  if (tickTimer) return;
  if (!isEmailDeliveryAvailable()) {
    appLogger.warn(
      "Email notification delivery is disabled; configure VEKTOR_EMAIL_FROM and VEKTOR_SMTP_HOST",
    );
    return;
  }

  void tick();
  tickTimer = setInterval(() => void tick(), TICK_INTERVAL_MS);
  tickTimer.unref?.();
  appLogger.info("Email notification worker started", {
    tickIntervalMs: TICK_INTERVAL_MS,
  });
}

export function stopEmailNotificationWorker(): void {
  if (!tickTimer) return;
  clearInterval(tickTimer);
  tickTimer = null;
}
