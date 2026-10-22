import { requireChatSessionOwner } from "#acl/guards.ts";
import { jsonResponse, requireParam, withApiErrorHandling } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { listAIChatSessionSummaries } from "#db/space/aiChatSessions.ts";
import type { Platform } from "#platform/platform.ts";

/**
 * List the caller's AI chat sessions in a space
 *
 * @tag AI
 * @jobToken
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const userId = await requireChatSessionOwner(
      context.var.platform,
      context.var.credentials,
      spaceId,
    );

    const store = await openSpaceStore(context.var.platform, spaceId);
    const sessions = await listAIChatSessionSummaries(store, userId);
    return jsonResponse({ sessions });
  }, "Failed to list AI chat sessions");
