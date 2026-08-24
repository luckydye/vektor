import { eq } from "drizzle-orm";
import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { config, getLocalOrigin } from "#config";
import { listActiveSpaceIds } from "#db/auth/spaceIndex.ts";
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
  retryEmailNotification,
} from "#db/space/emailOutbox.ts";
import { getRevisionContent } from "#db/space/revisions.ts";
import { getSpace } from "#db/space/spaces.ts";
import { propertyValueToText } from "#documents/properties.ts";
import { appLogger } from "#observability/logger.ts";
import { isEmailDeliveryAvailable, sendEmail } from "./email.ts";
import { renderNotificationEmail, renderSpaceInvitationEmail } from "./render.ts";

const TICK_INTERVAL_MS = 15_000;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickInProgress = false;

function appUrl(path: string): string {
  const origin = config().SITE_URL || config().API_URL || getLocalOrigin();
  return new URL(path, origin).toString();
}

function documentUrl(spaceSlug: string, documentSlug: string): string {
  return appUrl(
    `/${encodeURIComponent(spaceSlug)}/doc/${encodeURIComponent(documentSlug)}`,
  );
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
  const store = await openSpaceStore(spaceId);
  // An invitation announces the space itself and carries no document, which is
  // the case both the mute preference and the access check fall back on.
  const documentId = notification.documentId ?? undefined;
  const about = documentId ? "Document" : "Space";

  if (await isEmailMuted(store, notification.recipientUserId, documentId)) {
    await markEmailNotificationSkipped(store, notification.id, `${about} muted`);
    return;
  }

  try {
    await verifyAccess(
      spaceId,
      documentId
        ? { type: ResourceType.DOCUMENT, id: documentId }
        : { type: ResourceType.SPACE, id: spaceId },
      notification.recipientUserId,
      Permission.VIEWER,
    );
  } catch {
    await markEmailNotificationSkipped(store, notification.id, `${about} access revoked`);
    return;
  }

  const authDb = getAuthDb();
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
    documentId ? getDocument(store, documentId) : undefined,
    getSpace(spaceId),
  ]);

  if (!recipient?.email || !recipient.emailVerified) {
    await markEmailNotificationSkipped(store, notification.id, "No verified email");
    return;
  }
  if (!space) {
    await markEmailNotificationSkipped(store, notification.id, "Space unavailable");
    return;
  }
  const actorName = actor?.name || actor?.email || "Someone";

  if (notification.kind === "space_invitation") {
    await sendEmail({
      to: recipient.email,
      ...renderSpaceInvitationEmail({
        actorName,
        spaceName: space.name,
        spaceUrl: appUrl(`/${encodeURIComponent(space.slug)}`),
        role: notification.role ?? "",
        brandColor: space.preferences?.brandColor,
      }),
    });
    await markEmailNotificationSent(store, notification.id);
    return;
  }

  if (!doc) {
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
  const [commentRecord, publishedContent, previousPublishedContent] = await Promise.all([
    aboutComment ? getComment(store, notification.sourceId) : undefined,
    aboutPublication && typeof notification.publishedRevision === "number"
      ? getRevisionContent(store, doc.id, notification.publishedRevision)
      : undefined,
    notification.kind === "document_published" &&
    typeof notification.previousPublishedRevision === "number"
      ? getRevisionContent(store, doc.id, notification.previousPublishedRevision)
      : undefined,
  ]);
  if (aboutComment && !commentRecord) {
    await markEmailNotificationSkipped(store, notification.id, "Comment unavailable");
    return;
  }

  const rendered = renderNotificationEmail({
    notification,
    actorName,
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
  await sendEmail({ to: recipient.email, ...rendered });
  await markEmailNotificationSent(store, notification.id);
}

async function tick(): Promise<void> {
  if (tickInProgress) return;
  tickInProgress = true;
  try {
    for (const spaceId of await listActiveSpaceIds()) {
      const store = await openSpaceStore(spaceId);
      try {
        const due = await claimDueEmailNotifications(store);
        for (const notification of due) {
          try {
            await deliver(spaceId, notification);
          } catch (error) {
            await retryEmailNotification(store, notification, error);
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
