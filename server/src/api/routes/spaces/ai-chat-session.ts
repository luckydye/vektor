import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  jsonResponse,
  notFoundResponse,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { deleteAIChatSession, getAIChatSession } from "#db/space/aiChatSessions.ts";

/**
 * Read one AI chat session
 *
 * @tag AI
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const sessionId = requireParam(context.var.params, "sessionId");

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.VIEWER,
    );

    const store = await openSpaceStore(spaceId);
    const session = await getAIChatSession(store, sessionId, user.id);
    if (!session) {
      throw notFoundResponse("AI chat session");
    }

    return jsonResponse({ session });
  }, "Failed to get AI chat session");

/**
 * Delete an AI chat session
 *
 * @tag AI
 */
export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const sessionId = requireParam(context.var.params, "sessionId");

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.VIEWER,
    );

    const store = await openSpaceStore(spaceId);
    const session = await getAIChatSession(store, sessionId, user.id);
    if (!session) {
      throw notFoundResponse("AI chat session");
    }

    await deleteAIChatSession(store, sessionId, user.id);
    return jsonResponse({ success: true });
  }, "Failed to delete AI chat session");
