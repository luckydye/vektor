import { requireChatSession } from "#acl/guards.ts";
import { cancelChatRound, withRunning } from "#agent/chatTurns.ts";
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
  type ChatAccess,
  deleteChatSession,
  toChatSessionSummary,
  updateChannel,
} from "#db/space/chatSessions.ts";
import { sendSyncEvent } from "#realtime/events.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { closeChat } from "#runners/agents.ts";

/**
 * Read one chat session
 *
 * @tag AI
 * @jobToken
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const sessionId = requireParam(context.var.params, "sessionId");
    const { session } = await requireChatSession(
      context.var.platform,
      context.var.credentials,
      spaceId,
      sessionId,
      "read",
    );
    return jsonResponse({ session: withRunning(toChatSessionSummary(session)) });
  }, "Failed to get chat session");

function optionalText(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (value === undefined) return undefined;
  if (value !== null && typeof value !== "string") {
    throw badRequestResponse(`${name} must be a string`);
  }
  return value?.trim() || null;
}

/**
 * Edit a bot: its name, avatar, role prompt and access
 *
 * @tag AI
 * @jobToken
 * @body
 */
export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const { platform, credentials } = context.var;
    const spaceId = requireParam(context.var.params, "spaceId");
    const sessionId = requireParam(context.var.params, "sessionId");
    const { session, userId } = await requireChatSession(
      platform,
      credentials,
      spaceId,
      sessionId,
      "edit",
    );
    if (session.visibility !== "space" || session.parentSessionId) {
      throw badRequestResponse("Only a bot's channel can be edited");
    }

    const body = await parseJsonBody<Record<string, unknown>>(context.req.raw);
    const title = optionalText(body, "title");
    if (title === null) throw badRequestResponse("title must not be empty");
    const access = body.access;
    if (access !== undefined && access !== "viewer" && access !== "editor") {
      throw badRequestResponse("access must be viewer or editor");
    }
    if (access === "viewer" && session.node) {
      throw badRequestResponse("A bot on a node takes posts from editors only");
    }

    await updateChannel(
      await openSpaceStore(platform, spaceId),
      sessionId,
      {
        title,
        rolePrompt: optionalText(body, "rolePrompt"),
        avatar: optionalText(body, "avatar"),
        access: access as ChatAccess | undefined,
      },
      userId,
    );
    sendSyncEvent(spaceId, {
      topic: realtimeTopics.chat,
      data: { sessionId, parentSessionId: null, state: "updated" },
    });
    return jsonResponse({ success: true });
  }, "Failed to update chat session");

/**
 * Delete a chat session; a bot's channel goes with its threads
 *
 * @tag AI
 * @jobToken
 */
export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const { platform, credentials } = context.var;
    const spaceId = requireParam(context.var.params, "spaceId");
    const sessionId = requireParam(context.var.params, "sessionId");
    const { session, userId } = await requireChatSession(
      platform,
      credentials,
      spaceId,
      sessionId,
      // A private session is its creator's; a bot and its threads are the editors'.
      "edit",
    );

    const deleted = await deleteChatSession(
      await openSpaceStore(platform, spaceId),
      sessionId,
      userId,
    );
    for (const id of deleted) {
      cancelChatRound(spaceId, id);
      closeChat({ spaceId, chatId: id });
    }
    if (session.visibility === "space") {
      sendSyncEvent(spaceId, {
        topic: realtimeTopics.chat,
        data: { sessionId, parentSessionId: session.parentSessionId, state: "deleted" },
      });
    }
    return jsonResponse({ success: true });
  }, "Failed to delete chat session");
