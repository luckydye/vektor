import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  verifyDocumentAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  isDocumentEmailMuted,
  setDocumentEmailMuted,
} from "#db/emailNotificationPreferences.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");
    await verifyDocumentAccess(spaceId, documentId, user.id);

    return jsonResponse({
      muted: await isDocumentEmailMuted(spaceId, documentId, user.id),
    });
  }, "Failed to get document email preference");

export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId = requireParam(context.var.params, "documentId");
    await verifyDocumentAccess(spaceId, documentId, user.id);

    const body = await parseJsonBody(context.req.raw);
    if (typeof body.muted !== "boolean") {
      throw badRequestResponse("muted must be a boolean");
    }

    await setDocumentEmailMuted(spaceId, documentId, user.id, body.muted);
    return jsonResponse({ muted: body.muted });
  }, "Failed to update document email preference");
