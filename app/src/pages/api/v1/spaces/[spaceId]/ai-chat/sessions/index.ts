import type { APIRoute } from "astro";
import {
  jsonResponse,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { listAIChatSessions } from "#db/aiChatSessions.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");

    await verifySpaceRole(spaceId, user.id, "viewer");

    const sessions = await listAIChatSessions(spaceId, user.id);
    return jsonResponse({ sessions });
  }, "Failed to list AI chat sessions");
