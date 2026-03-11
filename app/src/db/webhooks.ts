import { eq } from "drizzle-orm";
import { webhook, type Webhook, type WebhookInsert } from "./schema/space.ts";
import type { getSpaceDb } from "./db.ts";
import { createAuditLog } from "./auditLogs.ts";
import { createId } from "./ids.ts";

export type WebhookEvent =
  | "document.published"
  | "document.unpublished"
  | "document.deleted"
  | "document.archived"
  | "document.restored"
  | "mention";

export const SUPPORTED_WEBHOOK_EVENTS: readonly WebhookEvent[] = [
  "document.published",
  "document.unpublished",
  "document.deleted",
  "document.archived",
  "document.restored",
  "mention",
];

export interface WebhookPayload {
  event: WebhookEvent;
  spaceId: string;
  documentId: string;
  revisionId?: number;
  timestamp: string;
  data?: Record<string, unknown>;
}

export async function createWebhook(
  db: Awaited<ReturnType<typeof getSpaceDb>>,
  params: {
    url: string;
    events: WebhookEvent[];
    documentId?: string;
    secret?: string;
    createdBy: string;
  },
): Promise<Webhook> {
  const id = createId("webhook");
  const now = new Date();

  const result = await db
    .insert(webhook)
    .values({
      id,
      url: params.url,
      events: JSON.stringify(params.events),
      documentId: params.documentId,
      secret: params.secret,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      createdBy: params.createdBy,
    })
    .returning();

  if (!result[0]) {
    throw new Error("Failed to create webhook");
  }

  return result[0];
}

export async function getWebhook(
  db: Awaited<ReturnType<typeof getSpaceDb>>,
  id: string,
): Promise<Webhook | null> {
  const result = await db.select().from(webhook).where(eq(webhook.id, id)).get();

  return result || null;
}

export async function listWebhooks(
  db: Awaited<ReturnType<typeof getSpaceDb>>,
): Promise<Webhook[]> {
  return db.select().from(webhook).all();
}

export async function updateWebhook(
  db: Awaited<ReturnType<typeof getSpaceDb>>,
  id: string,
  params: {
    url?: string;
    events?: WebhookEvent[];
    documentId?: string;
    secret?: string;
    enabled?: boolean;
  },
): Promise<Webhook> {
  const updates: Partial<WebhookInsert> = {
    updatedAt: new Date(),
  };

  if (params.url !== undefined) updates.url = params.url;
  if (params.events !== undefined) updates.events = JSON.stringify(params.events);
  if (params.documentId !== undefined) updates.documentId = params.documentId;
  if (params.secret !== undefined) updates.secret = params.secret;
  if (params.enabled !== undefined) updates.enabled = params.enabled;

  const result = await db
    .update(webhook)
    .set(updates)
    .where(eq(webhook.id, id))
    .returning();

  if (!result[0]) {
    throw new Error("Webhook not found");
  }

  return result[0];
}

export async function deleteWebhook(
  db: Awaited<ReturnType<typeof getSpaceDb>>,
  id: string,
): Promise<void> {
  await db.delete(webhook).where(eq(webhook.id, id));
}

export async function getWebhooksForEvent(
  db: Awaited<ReturnType<typeof getSpaceDb>>,
  event: WebhookEvent,
  documentId?: string,
): Promise<Webhook[]> {
  const allWebhooks = await db
    .select()
    .from(webhook)
    .where(eq(webhook.enabled, true))
    .all();

  return allWebhooks.filter((wh) => {
    try {
      const events = JSON.parse(wh.events) as WebhookEvent[];
      const hasEvent = events.includes(event);

      // If webhook has documentId filter, only match if it matches the event's documentId
      if (wh.documentId) {
        return hasEvent && wh.documentId === documentId;
      }

      // Otherwise, trigger for all documents
      return hasEvent;
    } catch {
      return false;
    }
  });
}

export async function triggerWebhooks(
  db: Awaited<ReturnType<typeof getSpaceDb>>,
  payload: WebhookPayload,
): Promise<void> {
  const webhooks = await getWebhooksForEvent(db, payload.event, payload.documentId);

  if (webhooks.length === 0) {
    return;
  }

  const promises = webhooks.map(async (wh) => {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "Wiki-Webhook/1.0",
      };

      if (wh.secret) {
        const signature = await generateSignature(JSON.stringify(payload), wh.secret);
        headers["X-Webhook-Signature"] = signature;
      }

      const response = await fetch(wh.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        console.error(
          `Webhook ${wh.id} failed: ${response.status} ${response.statusText}`,
        );

        await createAuditLog(db, {
          docId: payload.documentId,
          revisionId: payload.revisionId,
          userId: undefined,
          event: "webhook_failed",
          details: {
            webhookId: wh.id,
            webhookUrl: wh.url,
            webhookEvent: payload.event,
            statusCode: response.status,
            errorMessage: `${response.status} ${response.statusText}`,
          },
        });
      } else {
        await createAuditLog(db, {
          docId: payload.documentId,
          revisionId: payload.revisionId,
          userId: undefined,
          event: "webhook_success",
          details: {
            webhookId: wh.id,
            webhookUrl: wh.url,
            webhookEvent: payload.event,
            statusCode: response.status,
          },
        });
      }
    } catch (error) {
      console.error(`Webhook ${wh.id} error:`, error);

      await createAuditLog(db, {
        docId: payload.documentId,
        revisionId: payload.revisionId,
        userId: undefined,
        event: "webhook_failed",
        details: {
          webhookId: wh.id,
          webhookUrl: wh.url,
          webhookEvent: payload.event,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  await Promise.allSettled(promises);
}

async function generateSignature(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function parseWebhookEvents(wh: Webhook): WebhookEvent[] {
  try {
    return JSON.parse(wh.events) as WebhookEvent[];
  } catch {
    return [];
  }
}

export function validateWebhookEventsInput(events: unknown):
  | {
      valid: true;
      events: WebhookEvent[];
    }
  | {
      valid: false;
      message: string;
    } {
  if (!Array.isArray(events) || events.length === 0) {
    return { valid: false, message: "Events must be a non-empty array" };
  }

  const normalized: WebhookEvent[] = [];
  for (const event of events) {
    if (
      typeof event !== "string" ||
      !SUPPORTED_WEBHOOK_EVENTS.includes(event as WebhookEvent)
    ) {
      return { valid: false, message: `Invalid event: ${String(event)}` };
    }
    normalized.push(event as WebhookEvent);
  }

  return { valid: true, events: normalized };
}

export function toWebhookDto(wh: Webhook) {
  return {
    id: wh.id,
    url: wh.url,
    events: parseWebhookEvents(wh),
    documentId: wh.documentId,
    enabled: wh.enabled,
    createdAt: wh.createdAt,
    updatedAt: wh.updatedAt,
    createdBy: wh.createdBy,
  };
}
