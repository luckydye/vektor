import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
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

/**
 * Read the caller's notification preference for this space
 *
 * @tag Spaces
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const documentId =
      new URL(context.req.url).searchParams.get("documentId") || undefined;

    if (documentId) {
      await verifyAccess(
        spaceId,
        { type: ResourceType.DOCUMENT, id: documentId },
        user.id,
        Permission.VIEWER,
      );
    } else {
      await verifyAccess(
        spaceId,
        { type: ResourceType.SPACE, id: spaceId },
        user.id,
        Permission.VIEWER,
      );
    }

    const store = await openSpaceStore(spaceId);
    return jsonResponse({
      muted: await isEmailMuted(store, user.id, documentId),
    });
  }, "Failed to get notification preference");

/**
 * Update the caller's notification preference for this space
 *
 * @tag Spaces
 * @body
 */
export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    const body = await parseJsonBody(context.req.raw);
    const documentId = typeof body.documentId === "string" ? body.documentId : undefined;

    if (documentId) {
      await verifyAccess(
        spaceId,
        { type: ResourceType.DOCUMENT, id: documentId },
        user.id,
        Permission.VIEWER,
      );
    } else {
      await verifyAccess(
        spaceId,
        { type: ResourceType.SPACE, id: spaceId },
        user.id,
        Permission.VIEWER,
      );
    }

    if (typeof body.muted !== "boolean") {
      throw badRequestResponse("muted must be a boolean");
    }

    const store = await openSpaceStore(spaceId);
    await setEmailMuted(store, user.id, body.muted, documentId);
    return jsonResponse({ muted: body.muted });
  }, "Failed to update notification preference");
