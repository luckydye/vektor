import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { config, getLocalOrigin } from "#config";
import { verifyDocumentRole } from "#db/api.ts";
import { getComment } from "#db/comments.ts";
import { getAuthDb, listInMemorySpaceIds } from "#db/db.ts";
import { getDocument } from "#db/documents.ts";
import { isDocumentEmailMuted } from "#db/emailNotificationPreferences.ts";
import {
  claimDueEmailNotifications,
  markEmailNotificationSent,
  markEmailNotificationSkipped,
  retryEmailNotification,
} from "#db/emailNotifications.ts";
import { user } from "#db/schema/auth.ts";
import type { EmailNotificationOutbox } from "#db/schema/space.ts";
import { getSpace } from "#db/spaces.ts";
import { isInMemoryDb } from "#inMemoryDb";
import { appLogger } from "#observability/logger.ts";
import { propertyValueToText } from "#utils/documentProperties.ts";
import { isEmailDeliveryAvailable, sendEmail } from "./email.ts";
import { renderNotificationEmail } from "./render.ts";

const SPACES_DIR = join("./data", "spaces");
const TICK_INTERVAL_MS = 15_000;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickInProgress = false;

async function listSpaceIds(): Promise<string[]> {
  if (isInMemoryDb()) return listInMemorySpaceIds();
  try {
    const entries = await readdir(SPACES_DIR);
    return entries
      .filter((name) => name.endsWith(".db"))
      .map((name) => name.slice(0, -".db".length));
  } catch {
    return [];
  }
}

function documentUrl(spaceSlug: string, documentSlug: string): string {
  const origin = config().SITE_URL || config().API_URL || getLocalOrigin();
  return new URL(
    `/${encodeURIComponent(spaceSlug)}/doc/${encodeURIComponent(documentSlug)}`,
    origin,
  ).toString();
}

async function deliver(
  spaceId: string,
  notification: EmailNotificationOutbox,
): Promise<void> {
  if (
    await isDocumentEmailMuted(
      spaceId,
      notification.documentId,
      notification.recipientUserId,
    )
  ) {
    await markEmailNotificationSkipped(spaceId, notification.id, "Document muted");
    return;
  }

  try {
    await verifyDocumentRole(
      spaceId,
      notification.documentId,
      notification.recipientUserId,
      "viewer",
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
      .select({ name: user.name, email: user.email })
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
  const commentRecord =
    notification.kind === "comment_created"
      ? await getComment(spaceId, notification.sourceId)
      : undefined;
  if (notification.kind === "comment_created" && !commentRecord) {
    await markEmailNotificationSkipped(spaceId, notification.id, "Comment unavailable");
    return;
  }

  const rendered = renderNotificationEmail({
    notification,
    actorName: actor?.name || actor?.email || "Someone",
    documentTitle: title || "Untitled",
    spaceName: space.name,
    documentUrl: documentUrl(space.slug, doc.slug),
    commentContent: commentRecord?.content,
  });
  await sendEmail({ to: recipient.email, ...rendered });
  await markEmailNotificationSent(spaceId, notification.id);
}

async function tick(): Promise<void> {
  if (tickInProgress) return;
  tickInProgress = true;
  try {
    for (const spaceId of await listSpaceIds()) {
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
