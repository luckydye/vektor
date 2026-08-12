import { verifyDocumentAccess, verifySpaceAccess } from "#acl/guards.ts";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { isEmailMuted, setEmailMuted } from "#db/space/emailNotificationPreferences.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const store = await openSpaceStore(spaceId);
    const documentId =
      new URL(context.req.url).searchParams.get("documentId") || undefined;

    if (documentId) {
      await verifyDocumentAccess(spaceId, documentId, user.id);
    } else {
      await verifySpaceAccess(spaceId, user.id);
    }

    return jsonResponse({
      muted: await isEmailMuted(store, user.id, documentId),
    });
  }, "Failed to get notification preference");

export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const store = await openSpaceStore(spaceId);

    const body = await parseJsonBody(context.req.raw);
    const documentId = typeof body.documentId === "string" ? body.documentId : undefined;

    if (documentId) {
      await verifyDocumentAccess(spaceId, documentId, user.id);
    } else {
      await verifySpaceAccess(spaceId, user.id);
    }

    if (typeof body.muted !== "boolean") {
      throw badRequestResponse("muted must be a boolean");
    }

    await setEmailMuted(store, user.id, body.muted, documentId);
    return jsonResponse({ muted: body.muted });
  }, "Failed to update notification preference");
