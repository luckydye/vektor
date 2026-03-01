import { eq, desc, and } from "drizzle-orm";
import { auditLog, type AuditLog } from "./schema.ts";
import type { getSpaceDb } from "./db.ts";
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
 *
 * Webhook events:
 * - webhook_success: Webhook delivery succeeded
 * - webhook_failed: Webhook delivery failed
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
  | "property_delete"
  | "webhook_success"
  | "webhook_failed";

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
 *
 * Webhook fields:
 * - webhookId: The ID of the webhook that was triggered
 * - webhookUrl: The URL the webhook was sent to
 * - webhookEvent: The type of webhook event (e.g., "document.published", "mention")
 * - statusCode: HTTP status code from webhook delivery
 * - errorMessage: Error message if webhook delivery failed
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
  webhookId?: string;
  webhookUrl?: string;
  webhookEvent?: string;
  statusCode?: number;
  errorMessage?: string;
}

export interface CreateAuditLogParams {
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
const EVENT_TO_SYNC_SCOPE: Partial<Record<AuditEvent, string>> = {
  save: "document",
  publish: "document",
  unpublish: "document",
  restore: "document",
  archive: "document",
  delete: "document",
  create: "document",
  lock: "document",
  unlock: "document",
  acl_grant: "acl",
  acl_revoke: "acl",
  property_update: "property",
  property_delete: "property",
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
  db: ReturnType<typeof getSpaceDb>,
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
  const syncScope = EVENT_TO_SYNC_SCOPE[params.event];
  if (syncScope) sendSyncEvent(syncScope);

  return result[0];
}

export async function getAuditLogsForDocument(
  db: ReturnType<typeof getSpaceDb>,
  docId: string,
  limit = 100,
): Promise<AuditLog[]> {
  return db
    .select()
    .from(auditLog)
    .where(eq(auditLog.docId, docId))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit);
}

export async function getAuditLogsByUser(
  db: ReturnType<typeof getSpaceDb>,
  userId: string,
  limit = 100,
): Promise<AuditLog[]> {
  return db
    .select()
    .from(auditLog)
    .where(eq(auditLog.userId, userId))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit);
}

export async function getAuditLogsByEvent(
  db: ReturnType<typeof getSpaceDb>,
  event: AuditEvent,
  limit = 100,
): Promise<AuditLog[]> {
  return db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, event))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit);
}

export async function getRecentAuditLogs(
  db: ReturnType<typeof getSpaceDb>,
  limit = 100,
): Promise<AuditLog[]> {
  return db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit);
}

export async function getAuditLogsForDocumentByEvent(
  db: ReturnType<typeof getSpaceDb>,
  docId: string,
  event: AuditEvent,
  limit = 100,
): Promise<AuditLog[]> {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.docId, docId), eq(auditLog.event, event)))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit);
}

export function parseAuditDetails(log: AuditLog): AuditDetails | null {
  if (!log.details) return null;
  try {
    return JSON.parse(log.details);
  } catch {
    return null;
  }
}
