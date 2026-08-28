import { authenticateJobTokenOrSpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import { type AgentEvent, type ChatMessage, runAgentInWorker } from "#agent/agent.ts";
import { scheduleProfileUpdate } from "#agent/profileUpdater.ts";
import {
  badRequestResponse,
  errorResponse,
  parseJsonBody,
  unauthorizedResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ChatImage, ChatImageAttachment } from "#api/provider/types.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getLocalOrigin } from "#config";
import { openSpaceStore } from "#db/client/store.ts";
import { getAIChatSession, upsertAIChatSession } from "#db/space/aiChatSessions.ts";
import { listOAuthIntegrationsForUser } from "#db/space/oauthIntegrations.ts";
import { getUserProfile } from "#db/space/userProfiles.ts";
import { getFileStorage } from "#files/storage.ts";
import { isSafeUploadPath } from "#files/uploads.ts";
import { createJobToken, parseJobToken, verifyJobToken } from "#jobs/jobToken.ts";
import { appLogger } from "#observability/logger.ts";

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

const MAX_CHAT_IMAGE_BYTES = 20 * 1024 * 1024;

type ChatAttachment = {
  key: string;
  url: string;
  name: string;
  type: string;
  size: number;
  isImage: boolean;
};

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

function parseChatAttachments(value: unknown, spaceId: string): ChatAttachment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;

  const storage = getFileStorage();
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

/** Loads persisted image references only for the outbound model request. */
async function hydrateMessageImages(
  spaceId: string,
  messages: ChatMessage[],
): Promise<ChatMessage[]> {
  const storage = getFileStorage();
  return await Promise.all(
    messages.map(async (message) => {
      if (message.images?.length || !message.imageAttachments?.length) return message;

      const images = await Promise.all(
        message.imageAttachments.map(async (attachment): Promise<ChatImage | null> => {
          const file = await storage.read(spaceId, attachment.key);
          if (!file || file.byteLength > MAX_CHAT_IMAGE_BYTES) return null;
          return { mediaType: attachment.mediaType, data: file.toString("base64") };
        }),
      );
      return {
        ...message,
        images: images.filter((image): image is ChatImage => image !== null),
      };
    }),
  );
}

// Agent run types

type AgentRunResult = Awaited<ReturnType<typeof runAgentInWorker>>;

/**
 * A live agent turn, owned by the server rather than by any client connection.
 * A disconnect mid-turn (reload, network blip) does not stop the agent: the
 * next request with the same key re-attaches, replays the events so far, then
 * switches to live delivery. Completed turns linger for
 * ACTIVE_TURN_RETENTION_MS so a reconnect just after the agent finishes still
 * gets the result instead of re-running it.
 */
type ActiveChatTurn = {
  /** All events emitted so far; replayed to late-joining clients. */
  events: AgentEvent[];
  /** Callbacks for clients that are currently subscribed to live events. */
  listeners: Set<(event: AgentEvent) => void>;
  /** Resolves when the agent worker finishes (or errors). */
  promise: Promise<void>;
  result: AgentRunResult | null;
  error: string | null;
  updatedAt: number;
  /** Aborts the agent worker. Called by an explicit client cancel request. */
  abort: () => void;
};

// Turn registry

/** Keyed by `spaceId:userId:chatId`. */
const activeChatTurns = new Map<string, ActiveChatTurn>();

/** How long a completed turn stays in the map so reconnecting clients can catch up. */
const ACTIVE_TURN_RETENTION_MS = 1000 * 60 * 5;

/** Keep the streaming response active across reverse proxies while the agent is quiet. */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

function getActiveTurnKey(options: {
  spaceId: string;
  userId: string | null;
  chatId: string;
}): string {
  return [options.spaceId, options.userId ?? "job", options.chatId].join(":");
}

/**
 * Schedules removal of a completed turn from the in-memory map. `unref()`s the
 * timer where available so it cannot hold the process open under test.
 */
function scheduleActiveTurnCleanup(key: string, turn: ActiveChatTurn) {
  const timer = setTimeout(() => {
    if (activeChatTurns.get(key) === turn) {
      activeChatTurns.delete(key);
    }
  }, ACTIVE_TURN_RETENTION_MS);
  const maybeTimer = timer as { unref?: () => void };
  maybeTimer.unref?.();
}

/** Appends an event to the turn log and fans out to all connected listeners. */
function emitTurnEvent(turn: ActiveChatTurn, event: AgentEvent) {
  turn.events.push(event);
  turn.updatedAt = Date.now();
  for (const listener of turn.listeners) {
    listener(event);
  }
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
  if (toolName === "bash" || toolName === "js-exec") return "execute";
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

// Session persistence helpers

/**
 * Rebuilds a completed turn's display messages from its event stream, in the
 * order the client saw them stream:
 *
 *   pre-tool text (assistant) → tool result → post-tool text (assistant) → …
 *
 * Text is accumulated and flushed at each tool boundary, so pre- and post-tool
 * text stay separate bubbles. `fallbackContent` stands in when the turn emitted
 * no text at all, so it always has one visible response.
 */
function createTurnMessagesFromEvents(
  events: AgentEvent[],
  fallbackContent: string,
): unknown[] {
  const messages: unknown[] = [];
  const now = Date.now();
  let pendingText = "";

  const flushText = () => {
    if (pendingText.trim()) {
      messages.push({ role: "assistant", content: pendingText, timestamp: now });
      pendingText = "";
    }
  };

  for (const event of events) {
    if (event.type === "text") {
      pendingText += event.text;
    } else if (event.type === "tool_call") {
      flushText();
      // Save the call so the client can look up the command for `$ cmd` formatting
      // after reload. The call is never rendered (filtered out by the template).
      messages.push({
        role: "tool",
        content: event.toolArguments,
        timestamp: now,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        toolPhase: "call",
        isError: false,
      });
    } else if (event.type === "tool_result") {
      messages.push({
        role: "tool",
        content: event.content,
        timestamp: now,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        toolPhase: "result",
        isError: event.isError,
      });
    }
    // thinking and status are transient; not persisted.
  }

  flushText();

  if (!messages.some((m) => (m as { role: string }).role === "assistant")) {
    messages.push({ role: "assistant", content: fallbackContent, timestamp: now });
  }

  return messages;
}

/**
 * Persists the user message and every displayable event received before a turn
 * was stopped. The assistant history must still end with an assistant message,
 * otherwise opening the session would treat the stopped request as one to
 * reconnect and run again.
 */
async function persistCancelledChatTurn(options: {
  spaceId: string;
  chatId: string;
  userId: string;
  requestMessages: Array<{ role: string; content?: string | null }>;
  userAttachments: ChatAttachment[];
  events: AgentEvent[];
}) {
  const session = await getAIChatSession(
    await openSpaceStore(options.spaceId),
    options.chatId,
    options.userId,
  );
  if (!session) return;

  const lastUserRequest = [...options.requestMessages]
    .reverse()
    .find((message) => message.role === "user");
  const existingMessages = session.messages as Array<{ role?: string }>;
  const alreadyHasUserMessage = existingMessages.at(-1)?.role === "user";
  const userMessage =
    !alreadyHasUserMessage && lastUserRequest
      ? {
          role: "user",
          content: lastUserRequest.content ?? "",
          timestamp: Date.now(),
          ...(options.userAttachments.length
            ? { attachments: options.userAttachments }
            : {}),
        }
      : null;
  const partialAssistantContent = options.events
    .filter(
      (event): event is Extract<AgentEvent, { type: "text" }> => event.type === "text",
    )
    .map((event) => event.text)
    .join("");
  const stoppedMessage = partialAssistantContent.trim() || "Response stopped by user.";

  await upsertAIChatSession(await openSpaceStore(options.spaceId), options.userId, {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: Date.now(),
    messages: [
      ...(session.messages as unknown[]),
      ...(userMessage ? [userMessage] : []),
      ...createTurnMessagesFromEvents(options.events, stoppedMessage),
    ],
    conversationHistory: [
      ...options.requestMessages,
      { role: "assistant", content: stoppedMessage },
    ],
    shellSnapshot: session.shellSnapshot,
  });
}

async function persistCompletedChatTurn(options: {
  spaceId: string;
  chatId: string;
  userId: string;
  requestMessages: Array<{ role: string; content?: string | null }>;
  userAttachments: ChatAttachment[];
  events: AgentEvent[];
  result: AgentRunResult;
}) {
  const session = await getAIChatSession(
    await openSpaceStore(options.spaceId),
    options.chatId,
    options.userId,
  );
  if (!session) return;

  // The last user-role entry in requestMessages is the message that triggered
  // this turn.  Use its content as the display message for the session log.
  const lastUserRequest = [...options.requestMessages]
    .reverse()
    .find((m) => m.role === "user");

  // The pre-save step wrote the user message into session.messages before the
  // agent started.  Only add it here if it wasn't already pre-saved (e.g. when
  // running under a job token or when the pre-save was skipped), so we don't
  // end up with duplicate user messages in the display log.
  const existingMessages = session.messages as Array<{ role?: string }>;
  const alreadyHasUserMessage = existingMessages.at(-1)?.role === "user";
  const userMessage =
    !alreadyHasUserMessage && lastUserRequest
      ? {
          role: "user",
          content: lastUserRequest.content ?? "",
          timestamp: Date.now(),
          ...(options.userAttachments.length
            ? { attachments: options.userAttachments }
            : {}),
        }
      : null;

  const conversationHistory = [
    ...options.requestMessages,
    { role: "assistant", content: options.result.content },
  ];

  await upsertAIChatSession(await openSpaceStore(options.spaceId), options.userId, {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: Date.now(),
    messages: [
      // All messages from previous completed turns.
      ...(session.messages as unknown[]),
      // Current turn reconstructed in streaming order:
      // user → [pre-tool text] → tool result → [post-tool text] → …
      ...(userMessage ? [userMessage] : []),
      ...createTurnMessagesFromEvents(options.events, options.result.content),
    ],
    conversationHistory,
    shellSnapshot: options.result.shellSnapshot ?? null,
  });
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
 * SSE stream of `turn`'s `session/update` notifications: buffered events first
 * if it already finished, otherwise live until it does.
 *
 * Cancelling the stream (client disconnect) does NOT abort the agent; the turn
 * stays alive so the next request can reconnect.
 */
function createStreamingResponse(
  turn: ActiveChatTurn,
  requestId: string | number | null,
  sessionId: string,
): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        let closed = false;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
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

          // Replay buffered events to late-joining clients.
          for (const event of turn.events) {
            sendAgentEvent(event);
          }
          if (!turn.result && !turn.error) {
            turn.listeners.add(listener);
            await turn.promise;
          }

          if (turn.error) {
            send({
              jsonrpc: "2.0",
              id: requestId,
              error: { code: "server_error", message: turn.error },
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
          turn.listeners.delete(listener);
          closed = true;
          try {
            controller.close();
          } catch {
            // Client disconnected.
          }
        }
      },
      cancel() {
        // Keep the agent turn alive so a reload can reconnect to it.
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

// Turn management

/**
 * Returns the existing in-progress (or recently completed) turn for the given
 * key, or starts a fresh agent run and registers it.
 *
 * The agent worker is started without the HTTP request's AbortSignal so that
 * a client disconnect does not kill the agent.
 */
function getOrStartActiveChatTurn(options: {
  key: string;
  userId: string | null;
  chatId: string;
  messages: ChatMessage[];
  /** The persistent conversation, without turn-only generated context. */
  sessionMessages: ChatMessage[];
  /** Attachment display metadata persisted with the current user message. */
  userAttachments: ChatAttachment[];
  userProfile?: string;
  connectedProviders: string[];
  apiUrl: string;
  spaceId: string;
  documentId?: string;
  jobToken: string;
  shellSnapshot?: string | null;
}): ActiveChatTurn {
  const existing = activeChatTurns.get(options.key);
  if (existing && !existing.result && !existing.error) {
    // Turn is still in progress — reconnect this client to it.
    existing.updatedAt = Date.now();
    return existing;
  }
  // No in-progress turn (either none exists, or the previous one for this
  // session already completed).  Fall through to start a fresh turn.
  // Overwriting the map entry replaces any lingering completed turn.

  const turnAbortController = new AbortController();
  const turn: ActiveChatTurn = {
    events: [],
    listeners: new Set(),
    promise: Promise.resolve(),
    result: null,
    error: null,
    updatedAt: Date.now(),
    abort: () => turnAbortController.abort(),
  };
  activeChatTurns.set(options.key, turn);

  turn.promise = runAgentInWorker({
    chatId: options.chatId,
    messages: options.messages,
    userProfile: options.userProfile,
    connectedProviders: options.connectedProviders,
    apiUrl: options.apiUrl,
    spaceId: options.spaceId,
    documentId: options.documentId,
    jobToken: options.jobToken,
    shellSnapshot: options.shellSnapshot,
    signal: turnAbortController.signal,
    onEvent: (event) => {
      emitTurnEvent(turn, event);
    },
  })
    .then(async (result) => {
      turn.result = result;
      turn.updatedAt = Date.now();
      if (options.userId !== null) {
        await persistCompletedChatTurn({
          spaceId: options.spaceId,
          chatId: options.chatId,
          userId: options.userId,
          requestMessages: options.sessionMessages,
          userAttachments: options.userAttachments,
          events: turn.events,
          result,
        });
        // Schedule a profile update after idle.  Fetch the freshly-persisted
        // session so the updater has the complete display message history.
        const updatedSession = await getAIChatSession(
          await openSpaceStore(options.spaceId),
          options.chatId,
          options.userId,
        );
        if (updatedSession) {
          scheduleProfileUpdate({
            spaceId: options.spaceId,
            userId: options.userId,
            sessionMessages: updatedSession.messages as unknown[],
          });
        }
      }
    })
    .catch(async (error) => {
      const isAbort = error instanceof Error && error.name === "AbortError";
      if (isAbort) {
        if (options.userId !== null) {
          try {
            await persistCancelledChatTurn({
              spaceId: options.spaceId,
              chatId: options.chatId,
              userId: options.userId,
              requestMessages: options.sessionMessages,
              userAttachments: options.userAttachments,
              events: turn.events,
            });
          } catch (persistError) {
            appLogger.warn("Failed to persist cancelled chat turn", {
              chatId: options.chatId,
              spaceId: options.spaceId,
              error: persistError,
            });
          }
        }
      } else {
        appLogger.error("Chat turn failed", {
          chatId: options.chatId,
          spaceId: options.spaceId,
          error,
        });
        turn.error = error instanceof Error ? error.message : "Agent request failed";
      }
      turn.updatedAt = Date.now();
    })
    .finally(() => {
      scheduleActiveTurnCleanup(options.key, turn);
    });

  return turn;
}

// POST handler

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const body = await parseJsonBody<AcpJsonRpcRequest>(context.req.raw);

      if (body.jsonrpc !== "2.0" || !body.method) {
        return badRequestResponse("Invalid JSON-RPC 2.0 request");
      }

      const requestId = body.id ?? null;
      const params = (body.params ?? {}) as Record<string, unknown>;

      if (body.method === "session/prompt") {
        const sessionId = params.sessionId;
        const spaceId = params.spaceId;
        const documentId = params.documentId;
        const prompt = params.prompt;
        const imageAttachments = parseImageAttachments(params.imageAttachments);
        const attachmentInput = params.attachments;
        const additionalContext = params.additionalContext;

        if (!sessionId || typeof sessionId !== "string") {
          return badRequestResponse("params.sessionId is required");
        }
        if (!spaceId || typeof spaceId !== "string") {
          return badRequestResponse("params.spaceId is required");
        }
        if (documentId !== undefined && typeof documentId !== "string") {
          return badRequestResponse("params.documentId must be a string");
        }
        if (additionalContext !== undefined && typeof additionalContext !== "string") {
          return badRequestResponse("params.additionalContext must be a string");
        }
        if (imageAttachments === null) {
          return badRequestResponse(
            "params.imageAttachments must contain valid image uploads",
          );
        }
        const chatAttachments = parseChatAttachments(attachmentInput, spaceId);
        if (chatAttachments === null) {
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

        const userText = (prompt[0] as { text: string }).text;

        let jobToken: string;
        let userId: string | null = null;

        const providedJobToken = context.req.raw.headers.get("X-Job-Token");
        if (providedJobToken) {
          // Job-to-job: verify and reuse the provided token as-is.
          const headerSpaceId = context.req.raw.headers.get("X-Space-Id");
          if (!headerSpaceId || !verifyJobToken(providedJobToken, headerSpaceId)) {
            throw unauthorizedResponse();
          }
          if (headerSpaceId !== spaceId) {
            return badRequestResponse("spaceId does not match job token scope");
          }
          const parsed = parseJobToken(providedJobToken, spaceId);
          if (!parsed) throw unauthorizedResponse();
          jobToken = providedJobToken;
        } else {
          // Session cookie or Bearer token: server mints the job token.
          const auth = await authenticateJobTokenOrSpaceRole(
            context.var.credentials,
            spaceId,
            Permission.VIEWER,
          );
          userId = auth.type === "user" ? auth.user.id : (auth.userId ?? null);
          jobToken = createJobToken(spaceId, Date.now().toString(), userId);
        }

        // Load existing conversation history, user profile, and connected integrations from DB.
        const persistedSession =
          userId === null
            ? null
            : await getAIChatSession(await openSpaceStore(spaceId), sessionId, userId);
        const history = (persistedSession?.conversationHistory ??
          (userId === null && Array.isArray(params.messages)
            ? params.messages
            : [])) as ChatMessage[];
        const [userProfile, oauthIntegrations] = await Promise.all([
          userId !== null
            ? getUserProfile(await openSpaceStore(spaceId), userId).catch(() => null)
            : Promise.resolve(null),
          userId !== null
            ? listOAuthIntegrationsForUser(await openSpaceStore(spaceId), userId).catch(
                () => [],
              )
            : Promise.resolve([]),
        ]);
        const connectedProviders = oauthIntegrations.map((i) => i.provider);

        // If the history already ends with a user message it means the session
        // was interrupted mid-turn (the user message was pre-saved below but
        // the agent never completed).  In that case we reconnect as-is rather
        // than appending the user message a second time.
        const lastHistoryRole = history.at(-1)?.role;
        const messages: ChatMessage[] =
          lastHistoryRole === "user"
            ? history
            : [
                ...history,
                {
                  role: "user",
                  content: userText,
                  ...(imageAttachments.length ? { imageAttachments } : {}),
                },
              ];
        const agentMessages = additionalContext
          ? [
              ...messages,
              {
                role: "user" as const,
                content: `Additional context for the preceding message:\n${additionalContext}`,
              },
            ]
          : messages;
        const modelMessages = await hydrateMessageImages(spaceId, agentMessages);
        const currentMessageImages = modelMessages.find(
          (message) => message.imageAttachments === imageAttachments,
        )?.images;
        if (imageAttachments.length !== (currentMessageImages?.length ?? 0)) {
          return badRequestResponse(
            `Unable to read an image attachment (maximum ${MAX_CHAT_IMAGE_BYTES / 1024 / 1024}MB per image)`,
          );
        }

        // Pre-save the user message to the session BEFORE starting the agent.
        // This ensures that if the page is reloaded mid-turn the history shows
        // the pending message and getSessionStatus returns "awaiting".
        if (userId !== null && persistedSession && lastHistoryRole !== "user") {
          try {
            await upsertAIChatSession(await openSpaceStore(spaceId), userId, {
              id: persistedSession.id,
              title: persistedSession.title,
              createdAt: persistedSession.createdAt,
              updatedAt: Date.now(),
              messages: [
                ...(persistedSession.messages as unknown[]),
                {
                  role: "user",
                  content: userText,
                  timestamp: Date.now(),
                  ...(chatAttachments.length ? { attachments: chatAttachments } : {}),
                },
              ],
              conversationHistory: messages,
              shellSnapshot: persistedSession.shellSnapshot ?? null,
            });
          } catch {
            // Non-fatal — the turn still runs; worst case the user message
            // won't appear in history until the turn completes normally.
          }
        }

        const key = getActiveTurnKey({ spaceId, userId, chatId: sessionId });
        const turn = getOrStartActiveChatTurn({
          key,
          userId,
          chatId: sessionId,
          messages: modelMessages,
          sessionMessages: messages,
          userAttachments: chatAttachments,
          userProfile: userProfile ?? undefined,
          connectedProviders,
          apiUrl: getLocalOrigin(),
          spaceId,
          documentId: typeof documentId === "string" ? documentId : undefined,
          jobToken,
          shellSnapshot: persistedSession?.shellSnapshot ?? null,
        });

        return createStreamingResponse(turn, requestId, sessionId);
      }

      if (body.method === "session/cancel") {
        const sessionId = params.sessionId;
        const spaceId = params.spaceId;

        if (!sessionId || typeof sessionId !== "string") {
          return badRequestResponse("params.sessionId is required");
        }
        if (!spaceId || typeof spaceId !== "string") {
          return badRequestResponse("params.spaceId is required");
        }

        let userId: string | null = null;

        const cancelJobToken = context.req.raw.headers.get("X-Job-Token");
        if (cancelJobToken) {
          const headerSpaceId = context.req.raw.headers.get("X-Space-Id");
          if (!headerSpaceId || !verifyJobToken(cancelJobToken, headerSpaceId)) {
            throw unauthorizedResponse();
          }
          if (headerSpaceId !== spaceId) {
            return badRequestResponse("spaceId does not match job token scope");
          }
        } else {
          const auth = await authenticateJobTokenOrSpaceRole(
            context.var.credentials,
            spaceId,
            Permission.VIEWER,
          );
          userId = auth.type === "user" ? auth.user.id : (auth.userId ?? null);
        }

        const key = getActiveTurnKey({ spaceId, userId, chatId: sessionId });
        const turn = activeChatTurns.get(key);
        if (turn) {
          turn.abort();
          activeChatTurns.delete(key);
        }

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
