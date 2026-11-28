import { requireChatSession } from "#acl/guards.ts";
import { EVENT_SOURCE_PATTERN } from "#acl/permissions.ts";
import { postChatEvent } from "#agent/chatTurns.ts";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";

const MAX_TEXT_CHARS = 20_000;
const MAX_DATA_CHARS = 20_000;

/**
 * Post an event from an outside service to a chat session: the bot answers it in its next round
 *
 * @tag AI
 * @jobToken
 * @body
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const { platform, credentials } = context.var;
    const spaceId = requireParam(context.var.params, "spaceId");
    const sessionId = requireParam(context.var.params, "sessionId");
    // Whoever may post may post events: a service holds a space access token.
    const { session, userId, jobToken } = await requireChatSession(
      platform,
      credentials,
      spaceId,
      sessionId,
      "post",
    );

    const { source, text, data, wake } = await parseJsonBody<Record<string, unknown>>(
      context.req.raw,
    );
    if (typeof source !== "string" || !EVENT_SOURCE_PATTERN.test(source)) {
      throw badRequestResponse(
        "source must name the service: letters, digits, '.', '_' or '-', up to 64",
      );
    }
    if (typeof text !== "string" || !text.trim()) {
      throw badRequestResponse("text is required");
    }
    if (text.length > MAX_TEXT_CHARS) {
      throw badRequestResponse(`text must be at most ${MAX_TEXT_CHARS} characters`);
    }
    if (data !== undefined && JSON.stringify(data).length > MAX_DATA_CHARS) {
      throw badRequestResponse(`data must be at most ${MAX_DATA_CHARS} characters as JSON`);
    }
    if (wake !== undefined && typeof wake !== "boolean") {
      throw badRequestResponse("wake must be a boolean");
    }

    const seq = await postChatEvent(
      platform,
      session,
      { source, text, data, quiet: wake === false, sentBy: userId },
      jobToken,
    );
    return jsonResponse({ seq });
  }, "Failed to post chat event");
