import type { ApiRouteHandler } from "#api/server/types.ts";
import { listAIChatSessions } from "#db/aiChatSessions.ts";
import {
  jsonResponse,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");

    await verifySpaceRole(spaceId, user.id, "viewer");

    const sessions = await listAIChatSessions(spaceId, user.id);
    return jsonResponse({ sessions });
  }, "Failed to list AI chat sessions");
