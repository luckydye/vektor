import { and, eq, inArray, lte, or } from "drizzle-orm";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { emailNotificationOutbox } from "#db/schema/space.ts";

export type EmailNotificationKind =
  | "document_published"
  | "document_mention"
  | "comment_created"
  | "comment_mention"
  | "space_invitation";

export interface EmailNotificationInit {
  kind: EmailNotificationKind;
  sourceId: string;
  /** Null on an event about the space itself, such as an invitation. */
  documentId?: string | null;
  /** The role granted, on an invitation. */
  role?: string | null;
  publishedRevision?: number | null;
  previousPublishedRevision?: number | null;
  actorId: string;
}

/**
 * Queue one outbox row per recipient. Returns how many rows were actually
 * written — a recipient already queued for the same source is dropped by the
 * conflict clause rather than notified twice.
 */
export async function insertEmailNotifications(
  s: SpaceStore,
  notification: EmailNotificationInit,
  recipientUserIds: string[],
): Promise<number> {
  if (recipientUserIds.length === 0) return 0;
  const now = new Date();
  const inserted = await s.db
    .insert(emailNotificationOutbox)
    .values(
      recipientUserIds.map((recipientUserId) => ({
        id: createId("emailNotification"),
        kind: notification.kind,
        sourceId: notification.sourceId,
        documentId: notification.documentId ?? null,
        role: notification.role ?? null,
        publishedRevision: notification.publishedRevision ?? null,
        previousPublishedRevision: notification.previousPublishedRevision ?? null,
        actorId: notification.actorId,
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

export async function claimDueEmailNotifications(
  s: SpaceStore,
  limit = 50,
): Promise<(typeof emailNotificationOutbox.$inferSelect)[]> {
  const now = new Date();
  const staleAt = new Date(now.getTime() - 5 * 60 * 1000);
  const due = await many(
    s.db
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
      .limit(limit),
  );

  const claimed: (typeof emailNotificationOutbox.$inferSelect)[] = [];
  for (const row of due) {
    const updated = await one(
      s.db
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
        .returning(),
    );
    if (updated) claimed.push(updated);
  }
  return claimed;
}

export async function markEmailNotificationSent(
  s: SpaceStore,
  id: string,
): Promise<void> {
  const now = new Date();
  await s.db
    .update(emailNotificationOutbox)
    .set({ status: "sent", sentAt: now, updatedAt: now, lastError: null })
    .where(eq(emailNotificationOutbox.id, id));
}

export async function markEmailNotificationSkipped(
  s: SpaceStore,
  id: string,
  reason: string,
): Promise<void> {
  await s.db
    .update(emailNotificationOutbox)
    .set({ status: "skipped", lastError: reason, updatedAt: new Date() })
    .where(eq(emailNotificationOutbox.id, id));
}

export async function retryEmailNotification(
  s: SpaceStore,
  row: typeof emailNotificationOutbox.$inferSelect,
  error: unknown,
): Promise<void> {
  const attempts = row.attempts + 1;
  const permanentlyFailed = attempts >= 5;
  const delayMs = Math.min(60 * 60 * 1000, 30_000 * 2 ** (attempts - 1));
  const now = new Date();
  await s.db
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

/**
 * Cancel the mail a deleted document had queued but not yet sent.
 *
 * The outbox is append-only: a row is never removed, so what was already
 * delivered stays on the record and only what is still in flight is stopped.
 */
export async function cancelDocumentEmailNotifications(
  s: SpaceStore,
  documentId: string,
): Promise<void> {
  await s.db
    .update(emailNotificationOutbox)
    .set({
      status: "cancelled",
      lastError: "Document deleted",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(emailNotificationOutbox.documentId, documentId),
        inArray(emailNotificationOutbox.status, ["pending", "sending"]),
      ),
    );
}
