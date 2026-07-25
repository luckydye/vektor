import { and, desc, eq, lt, or } from "drizzle-orm";
import { sendSyncEvent } from "#realtime/events.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { decodeSeekCursor, encodeSeekCursor } from "./cursor.ts";
import type { getSpaceDb } from "./db.ts";
import { type AuditLog, auditLog } from "./schema.ts";

/**
 * Types of audit events that can be logged
 *
 * Document lifecycle events:
 * - create: Document is created
 * - save: Document content is saved
 * - suggest: Document content is saved as a suggested (non-current) revision
 * - publish: Document revision is published
 * - unpublish: Document is unpublished
 * - restore: Old revision is restored
 * - archive: Document is archived
 * - delete: Document is deleted
 * - view: Document is viewed
 * - comment: Comment is created on a document
 *
 * Document state events:
 * - lock: Document is locked (readonly)
 * - unlock: Document is unlocked
 *
 * Property events:
 * - property_update: Document property is created or updated
 * - property_delete: Document property is deleted
 *
 * Access control events:
 * - acl_grant: Permission is granted
 * - acl_revoke: Permission is revoked
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
 * Optional details that can be attached to audit log entries
 *
 * Common fields:
 * - ip: IP address of the user
 * - userAgent: User agent string
 * - referrer: HTTP referrer
 * - message: Human-readable message
 *
 * Property change fields (for property_update and property_delete events):
 * - propertyKey: The key of the property being changed (e.g., "title", "status")
 * - propertyType: The type of the property (optional)
 * - previousValue: The value before the change (undefined for new properties)
 * - newValue: The value after the change (for property_update only)
 *
 * @example Property update
 * ```ts
 * {
 *   propertyKey: "status",
 *   propertyType: "text",
 *   previousValue: "draft",
 *   newValue: "published"
 * }
 * ```
 *
 * @example Property creation
 * ```ts
 * {
 *   propertyKey: "author",
 *   previousValue: undefined, // No previous value for new properties
 *   newValue: "John Doe"
 * }
 * ```
 *
 * @example Property deletion
 * ```ts
 * {
 *   propertyKey: "obsolete-field",
 *   previousValue: "old value" // Captures what was deleted
 * }
 * ```
 *
 * Access control fields:
 * - permission: The permission being granted or revoked
 * - previousValue: The permission held before the change (undefined for a new grant)
 * - targetUserId / targetGroupId: Who the permission change applies to
 * - targetName: Display name of the target, captured at the time of the change so
 *   the entry stays readable after the member has been removed
 * - resourceType: What the permission applies to (space, document, feature, ...)
 * - resourceId: The id of that resource (the feature name for feature grants)
 *
 * @example Member invited to a space
 * ```ts
 * {
 *   permission: "editor",
 *   targetUserId: "usr_123",
 *   targetName: "Jane Doe",
 *   resourceType: "space"
 * }
 * ```
 */
export interface AuditDetails {
  ip?: string;
  userAgent?: string;
  referrer?: string;
  message?: string;
  previousValue?: string;
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
 * Maps audit events to sync scopes for automatic websocket sync
 *
 * When an audit event is created, if it has a sync scope, a websocket
 * event will be automatically sent to notify connected clients.
 *
 * Sync scopes:
 * - documents: Document changes (content, properties, state)
 * - acl: Access control changes
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

/**
 * Create an audit log entry
 *
 * Automatically triggers websocket sync events for relevant event types.
 *
 * @example Logging a property update
 * ```ts
 * await createAuditLog(db, {
 *   docId: documentId,
 *   userId: user.id,
 *   event: "property_update",
 *   details: {
 *     propertyKey: "status",
 *     previousValue: "draft",
 *     newValue: "published"
 *   }
 * });
 * ```
 *
 * @example Logging a property deletion
 * ```ts
 * await createAuditLog(db, {
 *   docId: documentId,
 *   userId: user.id,
 *   event: "property_delete",
 *   details: {
 *     propertyKey: "obsolete-field",
 *     previousValue: "old value"
 *   }
 * });
 * ```
 */
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

  // Automatically trigger sync events for relevant audit events
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
