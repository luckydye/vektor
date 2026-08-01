import { and, desc, eq, lt, or } from "drizzle-orm";
import { sendSyncEvent } from "#realtime/events.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { decodeSeekCursor, encodeSeekCursor } from "./cursor.ts";
import type { getSpaceDb } from "./db.ts";
import { type AuditLog, auditLog } from "./schema.ts";

/**
 * Every event kind the audit log records.
 *
 * `save` is an edit to the current revision; `suggest` is one parked as a
 * non-current revision awaiting review.
 */
export type AuditEvent =
  | "view"
  | "comment"
  | "save"
  | "suggest"
  | "publish"
  | "unpublish"
  | "restore"
  | "archive"
  | "delete"
  | "acl_grant"
  | "acl_revoke"
  | "create"
  | "lock"
  | "unlock"
  | "property_update"
  | "property_delete";

export const DOCUMENT_CONTRIBUTION_AUDIT_EVENTS: AuditEvent[] = [
  "create",
  "save",
  "suggest",
  "restore",
  "publish",
];

/**
 * Optional details attached to an audit log entry. Which fields are populated
 * depends on the event; all of them are absent unless the event sets them.
 */
export interface AuditDetails {
  ip?: string;
  userAgent?: string;
  referrer?: string;
  message?: string;
  /** Value before the change; absent when the property or grant is new. */
  previousValue?: string;
  /** Value after the change; absent on deletes. */
  newValue?: string;
  permission?: string;
  propertyKey?: string;
  propertyType?: string;
  /** Comment created by a comment event. */
  commentId?: string;
  /** Parent comment when the comment is a direct reply. */
  parentId?: string | null;
  /** Document selector or position anchoring the comment thread. */
  reference?: string | null;
  /** ACL events: user the permission change applies to. */
  targetUserId?: string;
  /** ACL events: group the permission change applies to. */
  targetGroupId?: string;
  /** ACL events: name (or email/id) of the target when the change was made. */
  targetName?: string;
  /** ACL events: resource type the permission applies to. */
  resourceType?: string;
  /** ACL events: resource the permission applies to (feature name for features). */
  resourceId?: string;
  /** Revision number this save/suggestion was based on. */
  parentRev?: number | null;
  /** Suggestion status at the time of the "suggest" event. */
  status?: "open" | "applied" | "dismissed" | null;
}

export interface CreateAuditLogParams {
  spaceId?: string;
  docId: string;
  revisionId?: number;
  userId?: string;
  event: AuditEvent;
  details?: AuditDetails;
}

/**
 * Events that notify connected clients, and the topics they publish to.
 * An event absent from this map is recorded without any websocket traffic.
 */
const EVENT_TO_SYNC_TOPICS: Partial<Record<AuditEvent, (docId: string) => string[]>> = {
  save: (docId) => [realtimeTopics.documents, realtimeTopics.document(docId)],
  publish: (docId) => [
    realtimeTopics.documents,
    realtimeTopics.documentTree,
    realtimeTopics.document(docId),
  ],
  unpublish: (docId) => [
    realtimeTopics.documents,
    realtimeTopics.documentTree,
    realtimeTopics.document(docId),
  ],
  restore: (docId) => [
    realtimeTopics.documents,
    realtimeTopics.documentTree,
    realtimeTopics.document(docId),
  ],
  archive: (docId) => [
    realtimeTopics.documents,
    realtimeTopics.documentTree,
    realtimeTopics.document(docId),
  ],
  delete: (docId) => [
    realtimeTopics.documents,
    realtimeTopics.documentTree,
    realtimeTopics.document(docId),
  ],
  create: (docId) => [
    realtimeTopics.documents,
    realtimeTopics.documentTree,
    realtimeTopics.document(docId),
  ],
  lock: (docId) => [realtimeTopics.documents, realtimeTopics.document(docId)],
  unlock: (docId) => [realtimeTopics.documents, realtimeTopics.document(docId)],
  acl_grant: () => [realtimeTopics.acl],
  acl_revoke: () => [realtimeTopics.acl],
};

/** Record an audit entry, and sync it to clients if the event has topics. */
export async function createAuditLog(
  db: Awaited<ReturnType<typeof getSpaceDb>>,
  params: CreateAuditLogParams,
): Promise<AuditLog> {
  const result = await db
    .insert(auditLog)
    .values({
      docId: params.docId,
      revisionId: params.revisionId,
      userId: params.userId,
      event: params.event,
      details: params.details ? JSON.stringify(params.details) : undefined,
      createdAt: new Date(),
    })
    .returning();
  if (!result[0]) {
    throw new Error("Failed to create audit log entry");
  }

  const syncTopics = EVENT_TO_SYNC_TOPICS[params.event]?.(params.docId);
  if (params.spaceId && syncTopics?.length) {
    sendSyncEvent(params.spaceId, ...syncTopics);
  }

  return result[0];
}

// Cursor encodes the (createdAt, id) position of the last returned row.
export function encodeAuditCursor(createdAt: Date, id: number): string {
  return encodeSeekCursor(createdAt.getTime(), id);
}

export function decodeAuditCursor(
  cursor: string,
): { createdAt: Date; id: number } | null {
  const pos = decodeSeekCursor(cursor, "number");
  if (!pos) return null;
  return { createdAt: new Date(pos.t), id: pos.id as number };
}

export async function getAuditLogsForDocument(
  db: Awaited<ReturnType<typeof getSpaceDb>>,
  docId: string,
  limit = 50,
  cursor?: string,
): Promise<{ rows: AuditLog[]; nextCursor: string | null }> {
  const where = eq(auditLog.docId, docId);
  const pos = cursor ? decodeAuditCursor(cursor) : null;
  const seekCondition = pos
    ? and(
        where,
        or(
          lt(auditLog.createdAt, pos.createdAt),
          and(eq(auditLog.createdAt, pos.createdAt), lt(auditLog.id, pos.id)),
        ),
      )
    : where;

  const fetchLimit = limit + 1;
  const rows = await db
    .select()
    .from(auditLog)
    .where(seekCondition)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(fetchLimit);

  let nextCursor: string | null = null;
  let page = rows;
  if (rows.length === fetchLimit) {
    page = rows.slice(0, -1);
    const last = page[page.length - 1];
    nextCursor = last ? encodeAuditCursor(last.createdAt, last.id) : null;
  }
  return { rows: page, nextCursor };
}

export async function getRecentAuditLogs(
  db: Awaited<ReturnType<typeof getSpaceDb>>,
  limit = 50,
  cursor?: string,
): Promise<{ rows: AuditLog[]; nextCursor: string | null }> {
  const pos = cursor ? decodeAuditCursor(cursor) : null;
  const seekCondition = pos
    ? or(
        lt(auditLog.createdAt, pos.createdAt),
        and(eq(auditLog.createdAt, pos.createdAt), lt(auditLog.id, pos.id)),
      )
    : undefined;

  const fetchLimit = limit + 1;
  const rows = await db
    .select()
    .from(auditLog)
    .where(seekCondition)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(fetchLimit);

  let nextCursor: string | null = null;
  let page = rows;
  if (rows.length === fetchLimit) {
    page = rows.slice(0, -1);
    const last = page[page.length - 1];
    nextCursor = last ? encodeAuditCursor(last.createdAt, last.id) : null;
  }
  return { rows: page, nextCursor };
}

export function parseAuditDetails(log: AuditLog): AuditDetails | null {
  if (!log.details) return null;
  try {
    return JSON.parse(log.details);
  } catch {
    return null;
  }
}
