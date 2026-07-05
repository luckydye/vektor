import { desc, eq, sql } from "drizzle-orm";
import { realtimeTopics } from "#utils/realtime.ts";
import type { getSpaceDb } from "./db.ts";
import { type AuditLog, auditLog } from "./schema.ts";
import { sendSyncEvent } from "./ws.ts";

/**
 * Types of audit events that can be logged
 *
 * Document lifecycle events:
 * - create: Document is created
 * - save: Document content is saved
 * - publish: Document revision is published
 * - unpublish: Document is unpublished
 * - restore: Old revision is restored
 * - archive: Document is archived
 * - delete: Document is deleted
 * - view: Document is viewed
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
  | "save"
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

export async function getAuditLogsForDocument(
  db: Awaited<ReturnType<typeof getSpaceDb>>,
  docId: string,
  limit = 50,
  offset = 0,
): Promise<{ rows: AuditLog[]; total: number }> {
  const where = eq(auditLog.docId, docId);
  const [countResult, rows] = await Promise.all([
    db.select({ total: sql<number>`count(*)` }).from(auditLog).where(where).get(),
    db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit)
      .offset(offset),
  ]);
  return { rows, total: countResult?.total ?? 0 };
}

export async function getRecentAuditLogs(
  db: Awaited<ReturnType<typeof getSpaceDb>>,
  limit = 50,
  offset = 0,
): Promise<{ rows: AuditLog[]; total: number }> {
  const [countResult, rows] = await Promise.all([
    // max(id) is O(1) from SQLite's B-tree header; accurate for append-only tables
    db.select({ total: sql<number>`coalesce(max(id), 0)` }).from(auditLog).get(),
    db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit)
      .offset(offset),
  ]);
  return { rows, total: countResult?.total ?? 0 };
}

export function parseAuditDetails(log: AuditLog): AuditDetails | null {
  if (!log.details) return null;
  try {
    return JSON.parse(log.details);
  } catch {
    return null;
  }
}
