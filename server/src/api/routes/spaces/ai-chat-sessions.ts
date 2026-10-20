import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  jsonResponse,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { listAIChatSessionSummaries } from "#db/space/aiChatSessions.ts";
import type { Platform } from "#platform/platform.ts";

/**
 * List the caller's AI chat sessions in a space
 *
 * @tag AI
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    await verifyAccess(
      context.var.platform,
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.VIEWER,
    );

    const store = await openSpaceStore(context.var.platform, spaceId);
    const sessions = await listAIChatSessionSummaries(store, user.id);
    return jsonResponse({ sessions });
  }, "Failed to list AI chat sessions");
