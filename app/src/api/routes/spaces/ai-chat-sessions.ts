import { verifySpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  jsonResponse,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { listAIChatSessionSummaries } from "#db/space/aiChatSessions.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    await verifySpaceRole(spaceId, user.id, Permission.VIEWER);

    const sessions = await listAIChatSessionSummaries(spaceId, user.id);
    return jsonResponse({ sessions });
  }, "Failed to list AI chat sessions");
