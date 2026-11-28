import { requireChatSession } from "#acl/guards.ts";
import {
  badRequestResponse,
  errorResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  appendChatMessages,
  listChatMessagesForToolCall,
  updateChannel,
} from "#db/space/chatSessions.ts";
import { sendSyncEvent } from "#realtime/events.ts";
import { realtimeTopics } from "#realtime/protocol.ts";

/** Role texts compare as the bot editor saves them: trimmed, and empty as none. */
const sameRole = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim() === (b ?? "").trim();

/**
 * Apply a role change the bot proposed in this channel or thread
 *
 * The proposal is the bot's `propose_role_update` call, named by `callId`. It is
 * applied only while the role still reads as it did when proposed, and the
 * application is logged in the session as a quiet message by the editor: that is
 * what marks the proposal applied, and how the bot learns of it.
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
    const { session, channel, userId } = await requireChatSession(
      platform,
      credentials,
      spaceId,
      sessionId,
      "edit",
    );
    if (session.visibility !== "space") {
      throw badRequestResponse("Only a bot has a role to change");
    }

    const { callId } = await parseJsonBody<Record<string, unknown>>(context.req.raw);
    if (typeof callId !== "string" || !callId) {
      throw badRequestResponse("callId is required");
    }

    const store = await openSpaceStore(platform, spaceId);
    const rows = await listChatMessagesForToolCall(store, sessionId, callId);
    const call = rows
      .flatMap((row) => row.metadata.tool_calls ?? [])
      .find((candidate) => candidate.id === callId);
    if (call?.function.name !== "propose_role_update") {
      throw notFoundResponse("Role proposal");
    }
    if (rows.some((row) => row.metadata.roleApplied?.callId === callId)) {
      return jsonResponse({ applied: true });
    }

    const { rolePrompt } = JSON.parse(call.function.arguments) as { rolePrompt?: unknown };
    if (typeof rolePrompt !== "string" || !rolePrompt.trim()) {
      throw badRequestResponse("The proposal holds no role text");
    }
    // Without the role it was made against there is no telling what it would overwrite.
    const result = rows.find((row) => row.metadata.tool_call_id === callId);
    const previous = result
      ? (JSON.parse(result.content) as { previous?: unknown }).previous
      : undefined;
    if (
      (previous !== null && typeof previous !== "string") ||
      !sameRole(previous, channel.rolePrompt)
    ) {
      throw errorResponse("The role changed since this was proposed", 409);
    }

    await updateChannel(store, channel.id, { rolePrompt: rolePrompt.trim() }, userId);
    await appendChatMessages(store, sessionId, [
      {
        role: "user",
        authorId: userId,
        content: "Applied your proposed role update.",
        metadata: { quiet: true, roleApplied: { callId } },
      },
    ]);
    sendSyncEvent(spaceId, {
      topic: realtimeTopics.chat,
      data: { sessionId, parentSessionId: session.parentSessionId, state: "updated" },
    });
    return jsonResponse({ applied: true });
  }, "Failed to apply the role proposal");
