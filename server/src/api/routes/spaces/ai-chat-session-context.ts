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
import { getAIChatSession } from "#db/space/aiChatSessions.ts";

/**
 * Read a chat session's full model context as its latest turn sent it: model, tools, system prompt and every message
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

    const session = await getAIChatSession(
      await openSpaceStore(spaceId),
      sessionId,
      user.id,
    );
    if (!session) {
      throw notFoundResponse("AI chat session");
    }

    // The system entry carries the model and tools the turn sent beside its prompt.
    const [first, ...rest] = session.conversationHistory as Array<
      Record<string, unknown>
    >;
    if (first?.role !== "system") {
      return jsonResponse({ messages: session.conversationHistory });
    }
    const { model, tools, ...systemMessage } = first;
    return jsonResponse({ model, tools, messages: [systemMessage, ...rest] });
  }, "Failed to get AI chat session context");
