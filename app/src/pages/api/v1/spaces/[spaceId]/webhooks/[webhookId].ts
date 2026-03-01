import type { APIRoute } from "astro";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  getWebhook,
  updateWebhook,
  deleteWebhook,
  toWebhookDto,
  validateWebhookEventsInput,
} from "#db/webhooks.ts";
import { getSpaceDb } from "#db/db.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const webhookId = requireParam(context.params, "webhookId");

    await verifySpaceRole(spaceId, user.id, "viewer");

    const db = await getSpaceDb(spaceId);
    const webhook = await getWebhook(db, webhookId);

    if (!webhook) {
      throw notFoundResponse("Webhook");
    }

    return jsonResponse({ webhook: toWebhookDto(webhook) });
  }, "Failed to get webhook");

export const PATCH: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const webhookId = requireParam(context.params, "webhookId");

    await verifySpaceRole(spaceId, user.id, "admin");

    const db = await getSpaceDb(spaceId);
    const existingWebhook = await getWebhook(db, webhookId);

    if (!existingWebhook) {
      throw notFoundResponse("Webhook");
    }

    const body = await parseJsonBody(context.request);
    const { url, events, documentId, secret, enabled } = body;
    let parsedEvents = events;

    if (url !== undefined && typeof url !== "string") {
      throw badRequestResponse("URL must be a string");
    }

    if (events !== undefined) {
      const validatedEvents = validateWebhookEventsInput(events);
      if (!validatedEvents.valid) {
        throw badRequestResponse(validatedEvents.message);
      }
      parsedEvents = validatedEvents.events;
    }

    if (
      documentId !== undefined &&
      documentId !== null &&
      typeof documentId !== "string"
    ) {
      throw badRequestResponse("Document ID must be a string or null");
    }

    if (secret !== undefined && secret !== null && typeof secret !== "string") {
      throw badRequestResponse("Secret must be a string or null");
    }

    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw badRequestResponse("Enabled must be a boolean");
    }

    const webhook = await updateWebhook(db, webhookId, {
      url,
      events: parsedEvents,
      documentId,
      secret,
      enabled,
    });

    return jsonResponse({ webhook: toWebhookDto(webhook) });
  }, "Failed to update webhook");

export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const webhookId = requireParam(context.params, "webhookId");

    await verifySpaceRole(spaceId, user.id, "admin");

    const db = await getSpaceDb(spaceId);
    const webhook = await getWebhook(db, webhookId);

    if (!webhook) {
      throw notFoundResponse("Webhook");
    }

    await deleteWebhook(db, webhookId);

    return jsonResponse({ success: true });
  }, "Failed to delete webhook");
