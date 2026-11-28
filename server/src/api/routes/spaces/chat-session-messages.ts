import { requireChatSession } from "#acl/guards.ts";
import { channelOfBotPrincipal } from "#acl/permissions.ts";
import { postChatMessage } from "#agent/chatTurns.ts";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  countConsecutiveBotMessages,
  listVisibleChatMessages,
  MAX_CONSECUTIVE_BOT_MESSAGES,
} from "#db/space/chatSessions.ts";
import { appLogger } from "#observability/logger.ts";
import { sendSyncEvent } from "#realtime/events.ts";
import { realtimeTopics } from "#realtime/protocol.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_TEXT_CHARS = 20_000;

function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw badRequestResponse(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Page through a chat session's messages, newest page first: `?before=<seq>&limit=<n>`
 *
 * @tag AI
 * @jobToken
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const { platform, credentials } = context.var;
    const spaceId = requireParam(context.var.params, "spaceId");
    const sessionId = requireParam(context.var.params, "sessionId");
    await requireChatSession(platform, credentials, spaceId, sessionId, "read");

    const url = new URL(context.req.url);
    const limit = Math.min(intParam(url, "limit") ?? DEFAULT_LIMIT, MAX_LIMIT);
    const messages = await listVisibleChatMessages(
      await openSpaceStore(platform, spaceId),
      sessionId,
      { beforeSeq: intParam(url, "before"), limit },
    );
    return jsonResponse({
      // Inline images are the model's; the UI shows the uploads they came from.
      messages: messages.map(({ metadata: { images: _images, ...metadata }, ...row }) => ({
        ...row,
        metadata,
      })),
      hasMore: messages.length === limit,
    });
  }, "Failed to list chat messages");

/**
 * Post a message to a chat session without streaming its round. A bot uses
 * this to message another bot; a person's tool could too.
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
    const { session, userId, jobToken } = await requireChatSession(
      platform,
      credentials,
      spaceId,
      sessionId,
      "post",
    );

    const { text } = await parseJsonBody<Record<string, unknown>>(context.req.raw);
    if (typeof text !== "string" || !text.trim()) {
      throw badRequestResponse("text is required");
    }
    if (text.length > MAX_TEXT_CHARS) {
      throw badRequestResponse(`text must be at most ${MAX_TEXT_CHARS} characters`);
    }

    const fromBot = channelOfBotPrincipal(userId);
    if (fromBot) {
      if (session.visibility !== "space" || session.parentSessionId) {
        throw badRequestResponse("Bots can only message bot channels");
      }
      if (session.id === fromBot) {
        throw badRequestResponse("A bot cannot message itself");
      }
      const store = await openSpaceStore(platform, spaceId);
      const consecutive = await countConsecutiveBotMessages(store, session.id);
      if (consecutive >= MAX_CONSECUTIVE_BOT_MESSAGES) {
        throw badRequestResponse(
          "These bots have gone back and forth too many times without a person; stop here.",
        );
      }
    }

    const { seq, round } = await postChatMessage(
      platform,
      session,
      {
        authorId: userId,
        text: text.trim(),
        attachments: [],
        imageAttachments: [],
        ...(fromBot ? { fromBot } : {}),
      },
      jobToken,
    );
    round.catch((error) =>
      appLogger.error("Chat message round failed", { spaceId, sessionId, error }),
    );
    if (fromBot) {
      sendSyncEvent(spaceId, {
        topic: realtimeTopics.chat,
        data: {
          sessionId,
          parentSessionId: session.parentSessionId,
          state: "posted",
        },
      });
    }
    return jsonResponse({ seq });
  }, "Failed to post chat message");
