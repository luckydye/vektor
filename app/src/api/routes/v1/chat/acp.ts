import type { APIRoute } from "astro";
import {
  badRequestResponse,
  errorResponse,
  parseJsonBody,
  requireUser,
  unauthorizedResponse,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { createJobToken, parseJobToken, verifyJobToken } from "#jobs/jobToken.ts";
import { getLocalOrigin } from "#config";
import { runAgentInWorker, type AgentEvent, type ChatMessage } from "#agent/agent.ts";
import { getAIChatSession, upsertAIChatSession } from "#db/aiChatSessions.ts";
import { appLogger } from "#observability/logger.ts";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

type AcpJsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Agent run types
// ---------------------------------------------------------------------------

type AgentRunResult = Awaited<ReturnType<typeof runAgentInWorker>>;

/**
 * A live agent turn that persists on the server independently of any client
 * HTTP connection.  When a streaming request arrives the server looks up an
 * existing turn by key before starting a new one.  If the client disconnects
 * mid-turn (page reload, network blip, etc.) the agent keeps running and any
 * new request with the same key re-attaches to the in-progress turn and
 * replays all events emitted so far before switching to live delivery.
 *
 * Completed turns are kept for ACTIVE_TURN_RETENTION_MS so a reconnect that
 * arrives just after the agent finishes can still receive the final result
 * without re-running the agent.
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

// ---------------------------------------------------------------------------
// Turn registry
// ---------------------------------------------------------------------------

/** Keyed by `spaceId:userId:chatId`. */
const activeChatTurns = new Map<string, ActiveChatTurn>();

/** How long a completed turn stays in the map so reconnecting clients can catch up. */
const ACTIVE_TURN_RETENTION_MS = 1000 * 60 * 5;

function getActiveTurnKey(options: {
  spaceId: string;
  userId: string | null;
  chatId: string;
}): string {
  return [options.spaceId, options.userId ?? "job", options.chatId].join(":");
}

/**
 * Schedules removal of a completed turn from the in-memory map.  Uses
 * `unref()` when available (Node.js) so the timer does not prevent process
 * exit during testing.
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

// ---------------------------------------------------------------------------
// ACP helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Session persistence helpers
// ---------------------------------------------------------------------------

/**
 * Reconstructs the display message sequence for a completed turn from its
 * ordered event stream, preserving the exact interleaving the client saw
 * while streaming:
 *
 *   pre-tool text (assistant) → tool result → post-tool text (assistant) → …
 *
 * - `text` events are accumulated into assistant messages, flushing each time
 *   a tool boundary is crossed so pre- and post-tool text appear as separate
 *   bubbles in the correct order.
 * - `tool_call` events flush accumulated text and are saved as hidden reference
 *   messages so `formatBashResultPreview` can reconstruct `$ cmd` after reload.
 * - `tool_result` events are saved as visible tool messages.
 * - `thinking` and `status` events are transient UI-only and not persisted.
 *
 * If no text was emitted at all, `fallbackContent` is used as a final
 * assistant message so the turn always has at least one visible response.
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
 * Appends the current turn's messages to the session log and updates the
 * conversation history.  The message list is built entirely from server-side
 * data — the user message comes from the request payload, tool messages come
 * from ACP events, and the assistant message comes from the agent result.
 * The client never writes display messages to the session.
 */
/**
 * Undoes the pre-save that was written before the turn started, restoring the
 * session to the state it was in before the user sent this message.  Called
 * when a turn is cancelled so the session doesn't get permanently stuck with a
 * dangling user message.
 */
async function rollbackPreSavedUserMessage(options: {
  spaceId: string;
  chatId: string;
  userId: string;
  preTurnHistory: ChatMessage[];
}) {
  const session = await getAIChatSession(options.spaceId, options.chatId, options.userId);
  if (!session) return;

  // Remove the user message that was appended by the pre-save.
  const messages = session.messages as unknown[];
  const lastMsg = messages.at(-1) as { role?: string } | undefined;
  const trimmedMessages = lastMsg?.role === "user" ? messages.slice(0, -1) : messages;

  await upsertAIChatSession(options.spaceId, options.userId, {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: Date.now(),
    messages: trimmedMessages,
    conversationHistory: options.preTurnHistory,
    shellSnapshot: session.shellSnapshot,
  });
}

async function persistCompletedChatTurn(options: {
  spaceId: string;
  chatId: string;
  userId: string;
  requestMessages: Array<{ role: string; content?: string | null }>;
  events: AgentEvent[];
  result: AgentRunResult;
}) {
  const session = await getAIChatSession(options.spaceId, options.chatId, options.userId);
  if (!session) return;

  // The last user-role entry in requestMessages is the message that triggered
  // this turn.  Use its content as the display message for the session log.
  const lastUserRequest = [...options.requestMessages].reverse().find((m) => m.role === "user");
  const userMessage = lastUserRequest
    ? { role: "user", content: lastUserRequest.content ?? "", timestamp: Date.now() }
    : null;

  const conversationHistory = [
    ...options.requestMessages,
    { role: "assistant", content: options.result.content },
  ];

  await upsertAIChatSession(options.spaceId, options.userId, {
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

// ---------------------------------------------------------------------------
// SSE streaming
// ---------------------------------------------------------------------------

/** Sends a JSON-RPC `session/update` notification over SSE. */
function sendUpdate(
  send: (payload: Record<string, unknown>) => void,
  sessionId: string,
  update: Record<string, unknown>,
) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

/**
 * Creates an SSE response that streams ACP `session/update` notifications from
 * `turn` to the caller.
 *
 * If the turn is already complete the buffered events are flushed immediately.
 * If it is still running the caller subscribes as a listener and receives
 * events in real-time until the turn finishes.
 *
 * Cancelling the stream (client disconnect) does NOT abort the agent; the
 * turn stays alive so the next request can reconnect.
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
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Turn management
// ---------------------------------------------------------------------------

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
  /** History before this turn's user message was added. Non-null only when a pre-save was written. */
  preTurnHistory: ChatMessage[] | null;
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
          requestMessages: options.messages,
          events: turn.events,
          result,
        });
      }
    })
    .catch(async (error) => {
      const isAbort = error instanceof Error && error.name === "AbortError";
      if (isAbort) {
        if (options.userId !== null && options.preTurnHistory !== null) {
          try {
            await rollbackPreSavedUserMessage({
              spaceId: options.spaceId,
              chatId: options.chatId,
              userId: options.userId,
              preTurnHistory: options.preTurnHistory,
            });
          } catch (rollbackError) {
            appLogger.warn("Failed to rollback pre-saved user message after cancellation", {
              chatId: options.chatId,
              spaceId: options.spaceId,
              error: rollbackError,
            });
          }
        }
      } else {
        appLogger.error("Chat turn failed", { chatId: options.chatId, spaceId: options.spaceId, error });
        turn.error = error instanceof Error ? error.message : "Agent request failed";
      }
      turn.updatedAt = Date.now();
    })
    .finally(() => {
      scheduleActiveTurnCleanup(options.key, turn);
    });

  return turn;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export const POST: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      const body = await parseJsonBody<AcpJsonRpcRequest>(context.request);

      if (body.jsonrpc !== "2.0" || !body.method) {
        return badRequestResponse("Invalid JSON-RPC 2.0 request");
      }

      const requestId = body.id ?? null;
      const params = (body.params ?? {}) as Record<string, unknown>;

      // -----------------------------------------------------------------------
      // session/prompt — start or resume a streaming agent turn
      // -----------------------------------------------------------------------
      if (body.method === "session/prompt") {
        const sessionId = params.sessionId;
        const spaceId = params.spaceId;
        const documentId = params.documentId;
        const prompt = params.prompt;

        if (!sessionId || typeof sessionId !== "string") {
          return badRequestResponse("params.sessionId is required");
        }
        if (!spaceId || typeof spaceId !== "string") {
          return badRequestResponse("params.spaceId is required");
        }
        if (documentId !== undefined && typeof documentId !== "string") {
          return badRequestResponse("params.documentId must be a string");
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

        if (!context.locals.user) {
          const providedJobToken = context.request.headers.get("X-Job-Token");
          const headerSpaceId = context.request.headers.get("X-Space-Id");
          if (
            !providedJobToken ||
            !headerSpaceId ||
            !verifyJobToken(providedJobToken, headerSpaceId)
          ) {
            throw unauthorizedResponse();
          }
          if (headerSpaceId !== spaceId) {
            return badRequestResponse("spaceId does not match job token scope");
          }
          const parsed = parseJobToken(providedJobToken, spaceId);
          if (!parsed) {
            throw unauthorizedResponse();
          }
          jobToken = providedJobToken;
        } else {
          const user = requireUser(context);
          await verifySpaceRole(spaceId, user.id, "viewer");
          userId = user.id;
          jobToken = createJobToken(spaceId, Date.now().toString(), user.id);
        }

        // Load existing conversation history from DB.
        const persistedSession =
          userId === null ? null : await getAIChatSession(spaceId, sessionId, userId);
        const history = (persistedSession?.conversationHistory ?? []) as ChatMessage[];

        // If the history already ends with a user message it means the session
        // was interrupted mid-turn (the user message was pre-saved below but
        // the agent never completed).  In that case we reconnect as-is rather
        // than appending the user message a second time.
        const lastHistoryRole = history.at(-1)?.role;
        const messages: ChatMessage[] =
          lastHistoryRole === "user"
            ? history
            : [...history, { role: "user", content: userText }];

        // Pre-save the user message to the session BEFORE starting the agent.
        // This ensures that if the page is reloaded mid-turn the history shows
        // the pending message and getSessionStatus returns "awaiting".
        if (userId !== null && persistedSession && lastHistoryRole !== "user") {
          try {
            await upsertAIChatSession(spaceId, userId, {
              id: persistedSession.id,
              title: persistedSession.title,
              createdAt: persistedSession.createdAt,
              updatedAt: Date.now(),
              messages: [
                ...(persistedSession.messages as unknown[]),
                { role: "user", content: userText, timestamp: Date.now() },
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
          messages,
          preTurnHistory:
            userId !== null && persistedSession && lastHistoryRole !== "user" ? history : null,
          apiUrl: getLocalOrigin(),
          spaceId,
          documentId: typeof documentId === "string" ? documentId : undefined,
          jobToken,
          shellSnapshot: persistedSession?.shellSnapshot ?? null,
        });

        return createStreamingResponse(turn, requestId, sessionId);
      }

      // -----------------------------------------------------------------------
      // session/cancel — abort an active turn
      // -----------------------------------------------------------------------
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

        if (!context.locals.user) {
          const providedJobToken = context.request.headers.get("X-Job-Token");
          const headerSpaceId = context.request.headers.get("X-Space-Id");
          if (
            !providedJobToken ||
            !headerSpaceId ||
            !verifyJobToken(providedJobToken, headerSpaceId)
          ) {
            throw unauthorizedResponse();
          }
          if (headerSpaceId !== spaceId) {
            return badRequestResponse("spaceId does not match job token scope");
          }
        } else {
          const user = requireUser(context);
          await verifySpaceRole(spaceId, user.id, "viewer");
          userId = user.id;
        }

        const key = getActiveTurnKey({ spaceId, userId, chatId: sessionId });
        const turn = activeChatTurns.get(key);
        if (turn) {
          turn.abort();
          activeChatTurns.delete(key);
        }

        return Response.json({ jsonrpc: "2.0", id: requestId, result: { cancelled: true } });
      }

      return badRequestResponse(`Unknown method: ${body.method}`);
    },
    {
      fallbackMessage: "Agent request failed",
      onError: (error) =>
        errorResponse(error instanceof Error ? error.message : "Agent request failed", 500),
    },
  );
