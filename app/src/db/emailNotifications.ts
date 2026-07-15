import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import { config } from "#config";
import { DOCUMENT_CONTRIBUTION_AUDIT_EVENTS } from "./auditLogs.ts";
import { getAuthDb, getSpaceDb } from "./db.ts";
import { getDocumentEmailMutedUserIds } from "./emailNotificationPreferences.ts";
import { createId } from "./ids.ts";
import { getUniqueMentionedEmails } from "./mentions.ts";
import { getPublishedContent } from "./revisions.ts";
import { user } from "./schema/auth.ts";
import { auditLog, comment, document, emailNotificationOutbox } from "./schema/space.ts";

export type EmailNotificationKind = "document_published" | "comment_created";

function normalizeCommentReference(reference: string | null): string | null {
  if (!reference) return null;
  try {
    const parsed = JSON.parse(reference) as { selector?: unknown };
    return typeof parsed.selector === "string" ? parsed.selector : reference;
  } catch {
    return reference;
  }
}

async function getContentContributorUserIds(
  spaceId: string,
  documentId: string,
): Promise<Set<string>> {
  const db = await getSpaceDb(spaceId);
  const [doc, rows] = await Promise.all([
    db
      .select({ createdBy: document.createdBy })
      .from(document)
      .where(eq(document.id, documentId))
      .get(),
    db
      .selectDistinct({ userId: auditLog.userId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.docId, documentId),
          inArray(auditLog.event, DOCUMENT_CONTRIBUTION_AUDIT_EVENTS),
        ),
      )
      .all(),
  ]);

  return new Set([
    ...(doc ? [doc.createdBy] : []),
    ...rows.flatMap(({ userId }) => (userId ? [userId] : [])),
  ]);
}

async function getMentionedUserIds(html: string | null): Promise<Set<string>> {
  if (!html) return new Set();
  const emails = getUniqueMentionedEmails(html).map((email) =>
    email.trim().toLowerCase(),
  );
  if (emails.length === 0) return new Set();

  const authDb = getAuthDb();
  const rows = await authDb
    .select({ id: user.id })
    .from(user)
    .where(inArray(sql<string>`lower(${user.email})`, emails))
    .all();
  return new Set(rows.map(({ id }) => id));
}

async function getThreadParticipantUserIds(
  spaceId: string,
  documentId: string,
  reference: string | null,
  parentId: string | null,
): Promise<Set<string>> {
  const db = await getSpaceDb(spaceId);
  const parent = parentId
    ? await db
        .select({ createdBy: comment.createdBy, reference: comment.reference })
        .from(comment)
        .where(
          and(
            eq(comment.id, parentId),
            eq(comment.resourceType, "document"),
            eq(comment.resourceId, documentId),
          ),
        )
        .get()
    : undefined;
  const normalizedReference = normalizeCommentReference(
    reference ?? parent?.reference ?? null,
  );
  if (!normalizedReference) return new Set();

  const rows = await db
    .select({ createdBy: comment.createdBy, reference: comment.reference })
    .from(comment)
    .where(
      and(
        eq(comment.resourceType, "document"),
        eq(comment.resourceId, documentId),
        eq(comment.archived, false),
      ),
    )
    .all();

  return new Set([
    ...(parent ? [parent.createdBy] : []),
    ...rows
      .filter((row) => normalizeCommentReference(row.reference) === normalizedReference)
      .map(({ createdBy }) => createdBy),
  ]);
}

async function enqueueRecipients(
  spaceId: string,
  params: {
    kind: EmailNotificationKind;
    sourceId: string;
    documentId: string;
    actorId: string;
    recipientUserIds: Iterable<string>;
  },
): Promise<number> {
  const appConfig = config();
  const deliveryConfigured =
    !!appConfig.EMAIL_FROM?.trim() && !!appConfig.SMTP_HOST?.trim();
  const developmentDelivery = import.meta.env.DEV || appConfig.NODE_ENV === "test";
  if (!deliveryConfigured && !developmentDelivery) return 0;

  const recipientUserIds = [...new Set(params.recipientUserIds)].filter(
    (userId) => userId !== params.actorId,
  );
  const mutedUserIds = await getDocumentEmailMutedUserIds(
    spaceId,
    params.documentId,
    recipientUserIds,
  );
  const recipients = recipientUserIds.filter((userId) => !mutedUserIds.has(userId));
  if (recipients.length === 0) return 0;

  const db = await getSpaceDb(spaceId);
  const now = new Date();
  const inserted = await db
    .insert(emailNotificationOutbox)
    .values(
      recipients.map((recipientUserId) => ({
        id: createId("emailNotification"),
        kind: params.kind,
        sourceId: params.sourceId,
        documentId: params.documentId,
        actorId: params.actorId,
        recipientUserId,
        status: "pending",
        attempts: 0,
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: emailNotificationOutbox.id });
  return inserted.length;
}

export async function enqueueDocumentPublishedEmails(params: {
  spaceId: string;
  documentId: string;
  publicationId: number;
  revision: number;
  publishedHtml: string;
  actorId: string;
}): Promise<number> {
  const [contributors, mentioned] = await Promise.all([
    getContentContributorUserIds(params.spaceId, params.documentId),
    getMentionedUserIds(params.publishedHtml),
  ]);

  return enqueueRecipients(params.spaceId, {
    kind: "document_published",
    sourceId: String(params.publicationId),
    documentId: params.documentId,
    actorId: params.actorId,
    recipientUserIds: [...contributors, ...mentioned],
  });
}

export async function enqueueCommentCreatedEmails(params: {
  spaceId: string;
  documentId: string;
  commentId: string;
  commentReference: string | null;
  commentParentId: string | null;
  actorId: string;
}): Promise<number> {
  const [contributors, publishedHtml, threadParticipants] = await Promise.all([
    getContentContributorUserIds(params.spaceId, params.documentId),
    getPublishedContent(params.spaceId, params.documentId),
    getThreadParticipantUserIds(
      params.spaceId,
      params.documentId,
      params.commentReference,
      params.commentParentId,
    ),
  ]);
  const mentioned = await getMentionedUserIds(publishedHtml);

  return enqueueRecipients(params.spaceId, {
    kind: "comment_created",
    sourceId: params.commentId,
    documentId: params.documentId,
    actorId: params.actorId,
    recipientUserIds: [...contributors, ...mentioned, ...threadParticipants],
  });
}

export async function claimDueEmailNotifications(
  spaceId: string,
  limit = 50,
): Promise<(typeof emailNotificationOutbox.$inferSelect)[]> {
  const db = await getSpaceDb(spaceId);
  const now = new Date();
  const staleAt = new Date(now.getTime() - 5 * 60 * 1000);
  const due = await db
    .select()
    .from(emailNotificationOutbox)
    .where(
      or(
        and(
          eq(emailNotificationOutbox.status, "pending"),
          lte(emailNotificationOutbox.availableAt, now),
        ),
        and(
          eq(emailNotificationOutbox.status, "sending"),
          lte(emailNotificationOutbox.updatedAt, staleAt),
        ),
      ),
    )
    .limit(limit)
    .all();

  const claimed: (typeof emailNotificationOutbox.$inferSelect)[] = [];
  for (const row of due) {
    const updated = await db
      .update(emailNotificationOutbox)
      .set({ status: "sending", updatedAt: now })
      .where(
        and(
          eq(emailNotificationOutbox.id, row.id),
          or(
            eq(emailNotificationOutbox.status, "pending"),
            and(
              eq(emailNotificationOutbox.status, "sending"),
              lte(emailNotificationOutbox.updatedAt, staleAt),
            ),
          ),
        ),
      )
      .returning()
      .get();
    if (updated) claimed.push(updated);
  }
  return claimed;
}

export async function markEmailNotificationSent(
  spaceId: string,
  id: string,
): Promise<void> {
  const db = await getSpaceDb(spaceId);
  const now = new Date();
  await db
    .update(emailNotificationOutbox)
    .set({ status: "sent", sentAt: now, updatedAt: now, lastError: null })
    .where(eq(emailNotificationOutbox.id, id));
}

export async function markEmailNotificationSkipped(
  spaceId: string,
  id: string,
  reason: string,
): Promise<void> {
  const db = await getSpaceDb(spaceId);
  await db
    .update(emailNotificationOutbox)
    .set({ status: "skipped", lastError: reason, updatedAt: new Date() })
    .where(eq(emailNotificationOutbox.id, id));
}

export async function retryEmailNotification(
  spaceId: string,
  row: typeof emailNotificationOutbox.$inferSelect,
  error: unknown,
): Promise<void> {
  const db = await getSpaceDb(spaceId);
  const attempts = row.attempts + 1;
  const permanentlyFailed = attempts >= 5;
  const delayMs = Math.min(60 * 60 * 1000, 30_000 * 2 ** (attempts - 1));
  const now = new Date();
  await db
    .update(emailNotificationOutbox)
    .set({
      status: permanentlyFailed ? "failed" : "pending",
      attempts,
      availableAt: new Date(now.getTime() + delayMs),
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: now,
    })
    .where(eq(emailNotificationOutbox.id, row.id));
}
