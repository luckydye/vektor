import {
  authenticateChatCaller,
  chatRoleNeeded,
  requireChatSession,
  verifyAccess,
} from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import type { AgentEvent } from "#agent/agent.ts";
import {
  cancelChatRound,
  type ChatRound,
  chatRound,
  postChatMessage,
} from "#agent/chatTurns.ts";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseJsonBody,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ChatImageAttachment } from "#api/provider/types.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  type ChatAccess,
  type ChatAttachment,
  type ChatVisibility,
  createChatSession,
  getChatMessage,
  getChatSession,
  listThreads,
} from "#db/space/chatSessions.ts";
import { isSafeUploadPath } from "#files/uploads.ts";
import type { Platform } from "#platform/platform.ts";
import { sendSyncEvent } from "#realtime/events.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { agentRunners } from "#runners/runners.ts";
import { isTimeZone } from "#utils/dateFormat.ts";
import { mentionsToText } from "#utils/markdown.ts";

// JSON-RPC 2.0 types

type AcpJsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

const VISION_IMAGE_MEDIA_TYPES = new Set<ChatImageAttachment["mediaType"]>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Keep the streaming response active across reverse proxies while the agent is quiet. */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

function parseImageAttachments(value: unknown): ChatImageAttachment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;

  const attachments: ChatImageAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { key, mediaType } = item as Record<string, unknown>;
    if (
      typeof key !== "string" ||
      !isSafeUploadPath(key) ||
      typeof mediaType !== "string" ||
      !VISION_IMAGE_MEDIA_TYPES.has(mediaType as ChatImageAttachment["mediaType"])
    ) {
      return null;
    }
    attachments.push({
      key,
      mediaType: mediaType as ChatImageAttachment["mediaType"],
    });
  }
  return attachments;
}

function parseChatAttachments(
  platform: Platform,
  value: unknown,
  spaceId: string,
): ChatAttachment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;

  const storage = platform.blobStore;
  const attachments: ChatAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { key, name, type, size } = item as Record<string, unknown>;
    if (
      typeof key !== "string" ||
      !isSafeUploadPath(key) ||
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 512 ||
      typeof type !== "string" ||
      type.length > 128 ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      return null;
    }
    const isImage = VISION_IMAGE_MEDIA_TYPES.has(
      type as ChatImageAttachment["mediaType"],
    );
    attachments.push({
      key,
      url: storage.url(spaceId, key),
      name,
      type,
      size,
      isImage,
    });
  }
  return attachments;
}

// ACP helpers

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function getToolKind(toolName: string): string {
  if (toolName === "bash") return "execute";
  if (
    toolName.startsWith("get_") ||
    toolName.startsWith("read_") ||
    toolName.startsWith("list_")
  )
    return "read";
  if (toolName.startsWith("search_") || toolName.startsWith("find_")) return "search";
  if (
    toolName.startsWith("create_") ||
    toolName.startsWith("update_") ||
    toolName.startsWith("write_") ||
    toolName.startsWith("edit_")
  )
    return "edit";
  if (toolName.startsWith("delete_") || toolName.startsWith("remove_")) return "delete";
  if (
    toolName.startsWith("upload_") ||
    toolName.startsWith("fetch_") ||
    toolName.startsWith("download_")
  )
    return "fetch";
  return "other";
}

// SSE streaming

/** Sends a JSON-RPC `session/update` notification over SSE. */
function sendUpdate(
  send: (payload: Record<string, unknown>) => void,
  sessionId: string,
  update: Record<string, unknown>,
) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

/**
 * SSE stream of a round's `session/update` notifications: buffered events
 * first if it already started, then live until it ends. The headers go out at
 * once, so a post waiting for the round in progress to finish is not idle.
 *
 * Cancelling the stream (client disconnect) does NOT abort the agent; the round
 * stays alive so the next request can reconnect.
 */
function createStreamingResponse(
  roundPromise: Promise<ChatRound>,
  requestId: string | number | null,
  sessionId: string,
): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        let closed = false;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let round: ChatRound | null = null;
        const send = (payload: Record<string, unknown> | string) => {
          if (closed) return;
          const data =
            typeof payload === "string"
              ? `data: ${payload}\n\n`
              : `data: ${JSON.stringify(payload)}\n\n`;
          try {
            controller.enqueue(encoder.encode(data));
          } catch {
            closed = true;
          }
        };

        const sendAgentEvent = (event: AgentEvent) => {
          if (event.type === "text") {
            sendUpdate(send, sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: event.text },
            });
          } else if (event.type === "thinking") {
            sendUpdate(send, sessionId, {
              sessionUpdate: "generic",
              generic: { type: "thinking", text: event.text },
            });
          } else if (event.type === "status") {
            sendUpdate(send, sessionId, {
              sessionUpdate: "plan",
              entries: [{ content: event.text, status: "in_progress" }],
            });
          } else if (event.type === "screen") {
            sendUpdate(send, sessionId, {
              sessionUpdate: "generic",
              generic: event,
            });
          } else if (event.type === "tool_call") {
            sendUpdate(send, sessionId, {
              sessionUpdate: "tool_call",
              toolCallId: event.toolCallId,
              title: event.toolName,
              kind: getToolKind(event.toolName),
              input: tryParseJson(event.toolArguments),
              status: "pending",
            });
            sendUpdate(send, sessionId, {
              sessionUpdate: "tool_call_update",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: "in_progress",
            });
          } else if (event.type === "tool_result") {
            sendUpdate(send, sessionId, {
              sessionUpdate: "tool_call_update",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: event.isError ? "failed" : "completed",
              content: [
                {
                  type: "content",
                  content: { type: "text", text: event.content },
                },
              ],
            });
          }
        };

        const listener = (event: AgentEvent) => sendAgentEvent(event);

        try {
          // Flush the response immediately and keep it active while the model is
          // thinking or a tool is running. Comment frames are ignored by SSE
          // clients but prevent nginx from treating the upstream as idle.
          controller.enqueue(encoder.encode(": connected\n\n"));
          heartbeat = setInterval(() => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
            } catch {
              closed = true;
              if (heartbeat) clearInterval(heartbeat);
            }
          }, SSE_HEARTBEAT_INTERVAL_MS);
          (heartbeat as { unref?: () => void }).unref?.();

          round = await roundPromise;
          // Replay buffered events to late-joining clients.
          for (const event of round.events) {
            sendAgentEvent(event);
          }
          if (!round.done) {
            round.listeners.add(listener);
            await round.promise;
          }

          if (round.error) {
            send({
              jsonrpc: "2.0",
              id: requestId,
              error: { code: "server_error", message: round.error },
            });
            send("[DONE]");
            return;
          }

          send({
            jsonrpc: "2.0",
            id: requestId,
            result: { stopReason: "end_turn" },
          });
          send("[DONE]");
        } catch (error) {
          send({
            jsonrpc: "2.0",
            id: requestId,
            error: {
              code: "server_error",
              message: error instanceof Error ? error.message : "Agent request failed",
            },
          });
          send("[DONE]");
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          round?.listeners.delete(listener);
          closed = true;
          try {
            controller.close();
          } catch {
            // Client disconnected.
          }
        }
      },
      cancel() {
        // Keep the round alive so a reload can reconnect to it.
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        // nginx buffers chunked upstream responses by default. ACP is a live
        // SSE stream and cannot set Content-Length like fixed asset responses.
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      },
    },
  );
}

// Request handling

function requireStringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (!value || typeof value !== "string") {
    throw badRequestResponse(`params.${name} is required`);
  }
  return value;
}

function optionalStringParam(params: Record<string, unknown>, name: string): string | null {
  const value = params[name] ?? null;
  if (value !== null && typeof value !== "string") {
    throw badRequestResponse(`params.${name} must be a string`);
  }
  return value;
}

function oneOf<T extends string>(
  params: Record<string, unknown>,
  name: string,
  values: readonly T[],
  initial: T,
): T {
  const value = params[name] ?? initial;
  if (!values.includes(value as T)) {
    throw badRequestResponse(`params.${name} must be one of ${values.join(", ")}`);
  }
  return value as T;
}

/** Fails unless `userId` may run agents on `node`, and it offers `agent`. */
async function requireNodeAgent(
  platform: Platform,
  spaceId: string,
  userId: string,
  node: string,
  agent: string | null,
): Promise<string> {
  const runner = (await agentRunners(platform, { spaceId, userId })).find(
    (candidate) => candidate.name === node,
  );
  if (!runner) throw badRequestResponse(`No node or runner "${node}" can run agents for you`);
  if (!agent) throw badRequestResponse("params.nodeAgent is required with params.node");
  if (!runner.description.agents.includes(agent)) {
    throw badRequestResponse(`"${node}" has no "${agent}" agent`);
  }
  return agent;
}

/** `session/new`: a private session, a bot's channel, or a thread in one. */
async function newSession(
  platform: Platform,
  credentials: Parameters<typeof authenticateChatCaller>[1],
  spaceId: string,
  params: Record<string, unknown>,
): Promise<string> {
  const { userId, source } = await authenticateChatCaller(platform, credentials, spaceId);
  const store = await openSpaceStore(platform, spaceId);
  const visibility = oneOf<ChatVisibility>(
    params,
    "visibility",
    ["space", "private"],
    "private",
  );
  const parentSessionId = optionalStringParam(params, "parentSessionId");

  if (parentSessionId) {
    if (visibility !== "space") {
      throw badRequestResponse("A thread needs params.visibility \"space\"");
    }
    const rootSeq = params.threadRootSeq;
    if (typeof rootSeq !== "number" || !Number.isSafeInteger(rootSeq)) {
      throw badRequestResponse("params.threadRootSeq is required for a thread");
    }
    const parent = await getChatSession(store, parentSessionId);
    if (!parent || parent.visibility !== "space" || parent.parentSessionId) {
      throw badRequestResponse("A thread's parent must be a bot's channel");
    }
    await verifyAccess(
      platform,
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      userId,
      chatRoleNeeded(parent, "post"),
    );
    const root = await getChatMessage(store, parent.id, rootSeq);
    if (!root?.visible) {
      throw badRequestResponse("params.threadRootSeq must be a message in the channel");
    }
    // One thread per message: replying again continues it.
    const existing = (await listThreads(store, parent.id)).find(
      (thread) => thread.threadRootSeq === rootSeq,
    );
    if (existing) return existing.id;
    const thread = await createChatSession(store, {
      title: mentionsToText(root.content).trim().slice(0, 60) || "Thread",
      createdBy: userId,
      source,
      visibility: "space",
      access: parent.access,
      rolePrompt: null,
      avatar: null,
      node: parent.node,
      nodeAgent: parent.nodeAgent,
      parentSessionId: parent.id,
      threadRootSeq: rootSeq,
    });
    sendSyncEvent(spaceId, {
      topic: realtimeTopics.chat,
      data: { sessionId: thread.id, parentSessionId: parent.id, state: "created" },
    });
    return thread.id;
  }

  const title = requireStringParam(params, "title").trim();
  if (!title) throw badRequestResponse("params.title is required");
  const node = optionalStringParam(params, "node");
  const nodeAgent = node
    ? await requireNodeAgent(
        platform,
        spaceId,
        userId,
        node,
        optionalStringParam(params, "nodeAgent"),
      )
    : null;

  if (visibility === "private") {
    for (const name of ["rolePrompt", "avatar", "access"]) {
      if (params[name] !== undefined) {
        throw badRequestResponse(`params.${name} is only for a bot's channel`);
      }
    }
    const session = await createChatSession(store, {
      title,
      createdBy: userId,
      source,
      visibility,
      access: "editor",
      rolePrompt: null,
      avatar: null,
      node,
      nodeAgent,
      parentSessionId: null,
      threadRootSeq: null,
    });
    return session.id;
  }

  await verifyAccess(
    platform,
    spaceId,
    { type: ResourceType.SPACE, id: spaceId },
    userId,
    Permission.EDITOR,
  );
  // Whoever may post runs commands on the node, so only editors may.
  const access: ChatAccess = node
    ? "editor"
    : oneOf<ChatAccess>(params, "access", ["viewer", "editor"], "editor");
  const channel = await createChatSession(store, {
    title,
    createdBy: userId,
    source,
    visibility,
    access,
    rolePrompt: optionalStringParam(params, "rolePrompt")?.trim() || null,
    avatar: optionalStringParam(params, "avatar")?.trim() || null,
    node,
    nodeAgent,
    parentSessionId: null,
    threadRootSeq: null,
  });
  sendSyncEvent(spaceId, {
    topic: realtimeTopics.chat,
    data: { sessionId: channel.id, parentSessionId: null, state: "created" },
  });
  return channel.id;
}

/**
 * Agent sessions over the Agent Client Protocol
 *
 * @tag AI
 * @jobToken
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const body = await parseJsonBody<AcpJsonRpcRequest>(context.req.raw);

      if (body.jsonrpc !== "2.0" || !body.method) {
        return badRequestResponse("Invalid JSON-RPC 2.0 request");
      }

      const { platform, credentials } = context.var;
      const requestId = body.id ?? null;
      const params = (body.params ?? {}) as Record<string, unknown>;
      const spaceId = requireStringParam(params, "spaceId");

      if (body.method === "session/new") {
        const sessionId = await newSession(platform, credentials, spaceId, params);
        return Response.json({ jsonrpc: "2.0", id: requestId, result: { sessionId } });
      }

      const sessionId = requireStringParam(params, "sessionId");

      if (body.method === "session/prompt") {
        const documentId = params.documentId;
        const prompt = params.prompt;
        const imageAttachments = parseImageAttachments(params.imageAttachments);
        const additionalContext = params.additionalContext;
        const timeZone = params.timeZone;

        if (documentId !== undefined && typeof documentId !== "string") {
          return badRequestResponse("params.documentId must be a string");
        }
        if (additionalContext !== undefined && typeof additionalContext !== "string") {
          return badRequestResponse("params.additionalContext must be a string");
        }
        if (timeZone !== undefined && !isTimeZone(timeZone)) {
          return badRequestResponse("params.timeZone must be an IANA time zone");
        }
        if (imageAttachments === null) {
          return badRequestResponse(
            "params.imageAttachments must contain valid image uploads",
          );
        }
        const attachments = parseChatAttachments(platform, params.attachments, spaceId);
        if (attachments === null) {
          return badRequestResponse(
            "params.attachments must contain valid uploaded files",
          );
        }
        if (
          !Array.isArray(prompt) ||
          prompt.length === 0 ||
          typeof (prompt[0] as { text?: unknown }).text !== "string"
        ) {
          return badRequestResponse(
            "params.prompt must be a non-empty array with a text entry",
          );
        }

        const { session, userId, jobToken } = await requireChatSession(
          platform,
          credentials,
          spaceId,
          sessionId,
          "post",
        );
        if (session.node && imageAttachments.length) {
          return badRequestResponse("Chats on a node take no image attachments");
        }

        const { round } = await postChatMessage(
          platform,
          session,
          {
            authorId: userId,
            text: (prompt[0] as { text: string }).text,
            attachments,
            imageAttachments,
            additionalContext: (additionalContext as string | undefined) || undefined,
            documentId: documentId as string | undefined,
            timeZone: timeZone as string | undefined,
          },
          jobToken,
        );
        return createStreamingResponse(round, requestId, sessionId);
      }

      if (body.method === "session/load") {
        await requireChatSession(platform, credentials, spaceId, sessionId, "read");
        const round = chatRound(spaceId, sessionId);
        if (!round) throw notFoundResponse("Running turn");
        return createStreamingResponse(Promise.resolve(round), requestId, sessionId);
      }

      if (body.method === "session/cancel") {
        await requireChatSession(platform, credentials, spaceId, sessionId, "post");
        cancelChatRound(spaceId, sessionId);
        return Response.json({
          jsonrpc: "2.0",
          id: requestId,
          result: { cancelled: true },
        });
      }

      return badRequestResponse(`Unknown method: ${body.method}`);
    },
    {
      fallbackMessage: "Agent request failed",
      onError: (error) =>
        errorResponse(
          error instanceof Error ? error.message : "Agent request failed",
          500,
        ),
    },
  );
