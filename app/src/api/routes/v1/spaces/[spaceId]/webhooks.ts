import type { APIRoute } from "astro";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { getSpaceDb } from "#db/db.ts";
import {
  createWebhook,
  listWebhooks,
  SsrfError,
  toWebhookDto,
  validateWebhookEventsInput,
  validateWebhookUrl,
} from "#db/webhooks.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");

    await verifySpaceRole(spaceId, user.id, "viewer");

    const db = await getSpaceDb(spaceId);
    const webhooks = await listWebhooks(db);

    return jsonResponse({ webhooks: webhooks.map(toWebhookDto) });
  }, "Failed to list webhooks");

export const POST: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");

    await verifySpaceRole(spaceId, user.id, "owner");

    const body = await parseJsonBody(context.request);
    const { url, events, documentId, secret } = body;

    if (!url || typeof url !== "string") {
      throw badRequestResponse("URL is required and must be a string");
    }

    try {
      await validateWebhookUrl(url);
    } catch (error) {
      if (error instanceof SsrfError) {
        throw badRequestResponse(`Invalid webhook URL: ${error.message}`);
      }
      throw error;
    }

    if (!events || !Array.isArray(events) || events.length === 0) {
      throw badRequestResponse("Events array is required and must not be empty");
    }

    const validatedEvents = validateWebhookEventsInput(events);
    if (!validatedEvents.valid) {
      throw badRequestResponse(validatedEvents.message);
    }

    if (documentId !== undefined && typeof documentId !== "string") {
      throw badRequestResponse("Document ID must be a string");
    }

    if (secret !== undefined && typeof secret !== "string") {
      throw badRequestResponse("Secret must be a string");
    }

    const db = await getSpaceDb(spaceId);
    const webhook = await createWebhook(db, {
      url,
      events: validatedEvents.events,
      documentId,
      secret,
      createdBy: user.id,
    });

    return jsonResponse({ webhook: toWebhookDto(webhook) });
  }, "Failed to create webhook");
