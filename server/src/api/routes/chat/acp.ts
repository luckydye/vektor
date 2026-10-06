import { authenticateJobTokenOrSpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  type AgentEvent,
  type AgentTurnSetup,
  type ChatMessage,
  runAgentInWorker,
} from "#agent/agent.ts";
import { AgentTurnError } from "#agent/core.ts";
import { scheduleProfileUpdate } from "#agent/profileUpdater.ts";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseJsonBody,
  withApiErrorHandling,
} from "#api/http.ts";
import type { AIProvider, ChatImage, ChatImageAttachment } from "#api/provider/types.ts";
import type { ApiContext, ApiRouteHandler } from "#api/server/types.ts";
import { getLocalOrigin } from "#config";
import { openSpaceStore } from "#db/client/store.ts";
import {
  type AIChatSessionSource,
  createAIChatSession,
  getAIChatSession,
  updateAIChatSession,
} from "#db/space/aiChatSessions.ts";
import { listOAuthIntegrationsForUser } from "#db/space/oauthIntegrations.ts";
import { getUserProfile } from "#db/space/userProfiles.ts";
import { getFileStorage } from "#files/storage.ts";
import { isSafeUploadPath } from "#files/uploads.ts";
import { resolveUserAIProvider } from "#integrations/aiProvider.ts";
import { createJobToken } from "#jobs/jobToken.ts";
import { appLogger } from "#observability/logger.ts";
import { isTimeZone } from "#utils/dateFormat.ts";

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

/**
 * A live agent turn, owned by the server rather than by any client connection.
 * A disconnect mid-turn (reload, network blip) does not stop the agent: a
 * `session/load` re-attaches, replays the events so far, then switches to live
 * delivery. Finished turns linger for ACTIVE_TURN_RETENTION_MS so a load just
 * after the agent finishes still gets the result.
 */
type ActiveChatTurn = {
  /** All events emitted so far; replayed to late-joining clients. */
  events: AgentEvent[];
  /** Callbacks for clients that are currently subscribed to live events. */
  listeners: Set<(event: AgentEvent) => void>;
  /** Resolves once the turn is finished and saved. */
  promise: Promise<void>;
  /** Set once the turn is saved to its session; until then the session is busy. */
  done: boolean;
  error: string | null;
  /** Null until the turn builds it; a turn failing before that sent nothing. */
  setup: AgentTurnSetup | null;
  updatedAt: number;
  /** Aborts the agent worker. Called by an explicit client cancel request. */
  abort: () => void;
};

// Turn registry

/** Keyed by `spaceId:userId:sessionId`. */
const activeChatTurns = new Map<string, ActiveChatTurn>();

/** How long a completed turn stays in the map so reconnecting clients can catch up. */
const ACTIVE_TURN_RETENTION_MS = 1000 * 60 * 5;

/** Keep the streaming response active across reverse proxies while the agent is quiet. */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

function getActiveTurnKey(options: {
  spaceId: string;
  userId: string;
  sessionId: string;
}): string {
  return [options.spaceId, options.userId, options.sessionId].join(":");
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
 * text stay separate bubbles. `fallbackContent`, when given, stands in for a
 * turn that emitted no text at all, so it has one visible response.
 */
function createTurnMessagesFromEvents(
  events: AgentEvent[],
  fallbackContent: string | null,
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

  if (
    fallbackContent !== null &&
    !messages.some((m) => (m as { role: string }).role === "assistant")
  ) {
    messages.push({ role: "assistant", content: fallbackContent, timestamp: now });
  }

  return messages;
}

/**
 * Saves the user's message before the agent starts, so the session shows it
 * while the turn runs and lists as awaiting a reply.
 */
async function saveUserMessage(options: {
  spaceId: string;
  sessionId: string;
  userId: string;
  userText: string;
  userAttachments: ChatAttachment[];
  /** The conversation the turn runs on, user message included. */
  requestMessages: ChatMessage[];
}) {
  const store = await openSpaceStore(options.spaceId);
  const session = await getAIChatSession(store, options.sessionId, options.userId);
  if (!session) throw new Error(`AI chat session ${options.sessionId} not found`);

  await updateAIChatSession(store, options.sessionId, options.userId, {
    messages: [
      ...session.messages,
      {
        role: "user",
        content: options.userText,
        timestamp: Date.now(),
        ...(options.userAttachments.length
          ? { attachments: options.userAttachments }
          : {}),
      },
    ],
    conversationHistory: [
      ...(session.conversationHistory as ChatMessage[]).filter(
        (message) => message.role === "system",
      ),
      ...options.requestMessages,
    ],
  });
}

/**
 * Appends a finished turn to the session: its display messages in streaming
 * order, and its model messages to the conversation history, led by the system
 * prompt the turn sent. The history must end with an assistant message,
 * otherwise the session would list as still awaiting a reply.
 */
async function persistChatTurn(options: {
  spaceId: string;
  sessionId: string;
  userId: string;
  requestMessages: ChatMessage[];
  events: AgentEvent[];
  /** The turn's own messages, as the model sent and received them. */
  turnMessages: ChatMessage[];
  /** Shown when the turn streamed no text of its own. */
  fallbackContent: string | null;
  /** Ends both logs after the turn's messages, e.g. the error that stopped it. */
  closingContent?: string;
  /** Leads the stored history as its system message, with the model and tools beside it. */
  setup: AgentTurnSetup | null;
  shellSnapshot?: string | null;
}) {
  const store = await openSpaceStore(options.spaceId);
  const session = await getAIChatSession(store, options.sessionId, options.userId);
  if (!session) throw new Error(`AI chat session ${options.sessionId} not found`);
  const closing = options.closingContent;

  await updateAIChatSession(store, options.sessionId, options.userId, {
    messages: [
      ...session.messages,
      ...createTurnMessagesFromEvents(options.events, options.fallbackContent),
      ...(closing
        ? [{ role: "assistant", content: closing, timestamp: Date.now() }]
        : []),
    ],
    conversationHistory: [
      ...(options.setup
        ? [
            {
              role: "system",
              content: options.setup.systemPrompt,
              model: options.setup.model,
              tools: options.setup.tools,
            },
          ]
        : []),
      ...options.requestMessages,
      ...options.turnMessages,
      ...(closing ? [{ role: "assistant", content: closing }] : []),
    ],
    shellSnapshot: options.shellSnapshot,
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
          if (!turn.done) {
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
 * Starts an agent turn on a session and registers it. The check for a running
 * turn and the registration happen without an await between them, so two
 * prompts on one session cannot both start.
 *
 * The agent worker is started without the HTTP request's AbortSignal so that
 * a client disconnect does not kill the agent.
 */
function startChatTurn(options: {
  key: string;
  userId: string;
  sessionId: string;
  /** The conversation as the model gets it, with images hydrated. */
  messages: ChatMessage[];
  /** The same conversation as persisted: image references, not bytes. */
  sessionMessages: ChatMessage[];
  /** The text the user sent, for the display log. */
  userText: string;
  /** Attachment display metadata persisted with the current user message. */
  userAttachments: ChatAttachment[];
  userProfile?: string;
  timeZone?: string;
  /** The session's stored system prompt; unset on its first turn. */
  systemPrompt?: string;
  connectedProviders: string[];
  provider: AIProvider;
  apiUrl: string;
  spaceId: string;
  documentId?: string;
  jobToken: string;
  shellSnapshot: string | null;
}): ActiveChatTurn {
  if (activeChatTurns.get(options.key)?.done === false) {
    throw errorResponse("A turn is already running in this session", 409);
  }

  const turnAbortController = new AbortController();
  const turn: ActiveChatTurn = {
    events: [],
    listeners: new Set(),
    promise: Promise.resolve(),
    done: false,
    error: null,
    setup: null,
    updatedAt: Date.now(),
    abort: () => turnAbortController.abort(),
  };
  activeChatTurns.set(options.key, turn);

  const persisted = {
    spaceId: options.spaceId,
    sessionId: options.sessionId,
    userId: options.userId,
    requestMessages: options.sessionMessages,
  };

  turn.promise = (async () => {
    await saveUserMessage({
      ...persisted,
      userText: options.userText,
      userAttachments: options.userAttachments,
    });

    let result: Awaited<ReturnType<typeof runAgentInWorker>>;
    try {
      result = await runAgentInWorker({
        chatId: options.sessionId,
        messages: options.messages,
        userProfile: options.userProfile,
        timeZone: options.timeZone,
        systemPrompt: options.systemPrompt,
        connectedProviders: options.connectedProviders,
        provider: options.provider,
        userId: options.userId,
        apiUrl: options.apiUrl,
        spaceId: options.spaceId,
        documentId: options.documentId,
        jobToken: options.jobToken,
        shellSnapshot: options.shellSnapshot,
        signal: turnAbortController.signal,
        onEvent: (event) => {
          emitTurnEvent(turn, event);
        },
        onSetup: (setup) => {
          turn.setup = setup;
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        const partialText = turn.events
          .flatMap((event) => (event.type === "text" ? [event.text] : []))
          .join("");
        const stoppedMessage = partialText.trim() || "Response stopped by user.";
        await persistChatTurn({
          ...persisted,
          events: turn.events,
          setup: turn.setup,
          turnMessages: [{ role: "assistant", content: stoppedMessage }],
          fallbackContent: stoppedMessage,
        });
        return;
      }
      appLogger.error("Chat turn failed", {
        sessionId: options.sessionId,
        spaceId: options.spaceId,
        error,
      });
      turn.error = error instanceof Error ? error.message : "Agent request failed";
      await persistChatTurn({
        ...persisted,
        events: turn.events,
        setup: turn.setup,
        turnMessages: error instanceof AgentTurnError ? error.messages : [],
        fallbackContent: null,
        closingContent: `Sorry, I encountered an error: ${turn.error}`,
      });
      return;
    }

    await persistChatTurn({
      ...persisted,
      events: turn.events,
      setup: turn.setup,
      turnMessages: result.messages,
      fallbackContent: result.content,
      shellSnapshot: result.shellSnapshot ?? null,
    });
    // Schedule a profile update after idle.  Fetch the freshly-persisted
    // session so the updater has the complete display message history.
    const updatedSession = await getAIChatSession(
      await openSpaceStore(options.spaceId),
      options.sessionId,
      options.userId,
    );
    if (updatedSession) {
      scheduleProfileUpdate({
        spaceId: options.spaceId,
        userId: options.userId,
        sessionMessages: updatedSession.messages as unknown[],
      });
    }
  })()
    .catch((error) => {
      appLogger.error("Failed to save chat turn", {
        sessionId: options.sessionId,
        spaceId: options.spaceId,
        error,
      });
      turn.error ??= error instanceof Error ? error.message : "Failed to save chat turn";
    })
    .finally(() => {
      turn.done = true;
      turn.updatedAt = Date.now();
      scheduleActiveTurnCleanup(options.key, turn);
    });

  return turn;
}

// Request handling

/**
 * The user a request acts for, and the job token its agent turn runs with.
 * A session always belongs to a user, so a user-less job token is refused.
 */
async function authenticateAgentCaller(
  context: ApiContext,
  spaceId: string,
): Promise<{ userId: string; jobToken: string; source: AIChatSessionSource }> {
  const { credentials } = context.var;
  const auth = await authenticateJobTokenOrSpaceRole(
    credentials,
    spaceId,
    Permission.VIEWER,
  );
  const userId = auth.type === "user" ? auth.user.id : auth.userId;
  if (!userId) {
    throw forbiddenResponse("Agent sessions belong to a user; this job token has none");
  }
  if (credentials.jobToken) {
    return { userId, jobToken: credentials.jobToken, source: "job" };
  }
  return {
    userId,
    jobToken: createJobToken(spaceId, Date.now().toString(), userId, { app: "agent" }),
    source: "chat",
  };
}

function requireStringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (!value || typeof value !== "string") {
    throw badRequestResponse(`params.${name} is required`);
  }
  return value;
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

      const requestId = body.id ?? null;
      const params = (body.params ?? {}) as Record<string, unknown>;
      const spaceId = requireStringParam(params, "spaceId");

      if (body.method === "session/new") {
        const title = requireStringParam(params, "title").trim();
        if (!title) return badRequestResponse("params.title is required");
        const { userId, source } = await authenticateAgentCaller(context, spaceId);
        const session = await createAIChatSession(await openSpaceStore(spaceId), userId, {
          title,
          source,
        });
        return Response.json({
          jsonrpc: "2.0",
          id: requestId,
          result: { sessionId: session.id },
        });
      }

      const sessionId = requireStringParam(params, "sessionId");
      const { userId, jobToken } = await authenticateAgentCaller(context, spaceId);
      const key = getActiveTurnKey({ spaceId, userId, sessionId });

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
        const chatAttachments = parseChatAttachments(params.attachments, spaceId);
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

        const store = await openSpaceStore(spaceId);
        const session = await getAIChatSession(store, sessionId, userId);
        if (!session) throw notFoundResponse("AI chat session");

        // The system message is fixed for the session: every turn resends the stored one.
        const storedHistory = session.conversationHistory as ChatMessage[];
        const storedSystem = storedHistory.filter((message) => message.role === "system");
        const history = storedHistory.filter((message) => message.role !== "system");
        const [userProfile, oauthIntegrations, provider] = await Promise.all([
          getUserProfile(store, userId).catch(() => null),
          listOAuthIntegrationsForUser(store, userId).catch(() => []),
          resolveUserAIProvider(spaceId, userId),
        ]);

        const messages: ChatMessage[] = [
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

        const turn = startChatTurn({
          key,
          userId,
          sessionId,
          messages: modelMessages,
          sessionMessages: agentMessages,
          userText,
          systemPrompt: storedSystem[0]?.content ?? undefined,
          userAttachments: chatAttachments,
          userProfile: userProfile ?? undefined,
          timeZone,
          connectedProviders: oauthIntegrations.map((i) => i.provider),
          provider,
          apiUrl: getLocalOrigin(),
          spaceId,
          documentId: typeof documentId === "string" ? documentId : undefined,
          jobToken,
          shellSnapshot: session.shellSnapshot,
        });

        return createStreamingResponse(turn, requestId, sessionId);
      }

      if (body.method === "session/load") {
        const session = await getAIChatSession(
          await openSpaceStore(spaceId),
          sessionId,
          userId,
        );
        if (!session) throw notFoundResponse("AI chat session");
        const turn = activeChatTurns.get(key);
        if (!turn) throw notFoundResponse("Running turn");
        return createStreamingResponse(turn, requestId, sessionId);
      }

      if (body.method === "session/cancel") {
        activeChatTurns.get(key)?.abort();
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
