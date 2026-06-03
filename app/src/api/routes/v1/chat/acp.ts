import type { APIRoute } from "astro";
import { createHash } from "node:crypto";
import {
  badRequestResponse,
  errorResponse,
  parseJsonBody,
  requireUser,
  unauthorizedResponse,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  createJobToken,
  parseJobToken,
  verifyJobToken,
} from "#jobs/jobToken.ts";
import { getLocalOrigin } from "#config";
import { runAgentInWorker, type AgentEvent } from "#agent/agent.ts";
import {
  getAIChatSession,
  upsertAIChatSession,
} from "#db/aiChatSessions.ts";

type ChatRole = "system" | "user" | "assistant" | "tool";

type ChatContentPart = {
  type: string;
  text?: string;
};

type ChatMessage = {
  role: ChatRole;
  content: string | ChatContentPart[];
  thinking?: string | null;
};

type AcpRequestBody = {
  messages?: ChatMessage[];
  stream?: boolean;
  chatId?: string;
  spaceId?: string;
  documentId?: string;
};

type NormalizedChatMessage = {
  role: ChatRole;
  content: string | null;
  thinking?: string | null;
};

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

/**
 * Keyed by `spaceId:userId:chatId:messagesFingerprint`.  The fingerprint is a
 * SHA-256 of the serialized request messages so that a retry with a different
 * message list always starts a fresh turn instead of reusing a stale one.
 */
const activeChatTurns = new Map<string, ActiveChatTurn>();

/** How long a completed turn stays in the map so reconnecting clients can catch up. */
const ACTIVE_TURN_RETENTION_MS = 1000 * 60 * 5;

function normalizeMessages(
  messages: ChatMessage[],
): NormalizedChatMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === "string"
        ? m.content
        : m.content.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join(""),
    ...(typeof m.thinking === "string" ? { thinking: m.thinking } : {}),
  }));
}

function getMessagesFingerprint(messages: NormalizedChatMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function getActiveTurnKey(options: {
  spaceId: string;
  userId: string | null;
  chatId: string;
  messages: NormalizedChatMessage[];
}): string {
  return [
    options.spaceId,
    options.userId ?? "job",
    options.chatId,
    getMessagesFingerprint(options.messages),
  ].join(":");
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

/** Appends an event to the turn log and fan-outs to all connected listeners. */
function emitTurnEvent(turn: ActiveChatTurn, event: AgentEvent) {
  turn.events.push(event);
  turn.updatedAt = Date.now();
  for (const listener of turn.listeners) {
    listener(event);
  }
}

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
 * - `tool_result` events are saved as tool messages (call-phase is omitted
 *   because the result already shows the command via the `$ cmd` prefix).
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
      // tool_call is not persisted; the result's `$ cmd` prefix carries the command.
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
async function persistCompletedChatTurn(options: {
  spaceId: string;
  chatId: string;
  userId: string;
  requestMessages: NormalizedChatMessage[];
  events: AgentEvent[];
  result: AgentRunResult;
}) {
  const session = await getAIChatSession(
    options.spaceId,
    options.chatId,
    options.userId,
  );
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

function createChunkPayload(options: {
  id: string;
  created: number;
  content?: string;
  finishReason?: string | null;
  stopReason?: string;
  role?: "assistant";
  event?: AgentEvent;
}): Record<string, unknown> {
  const delta: Record<string, string> = {};
  if (options.role) delta.role = options.role;
  if (options.content) delta.content = options.content;

  const payload: Record<string, unknown> = {
    id: options.id,
    object: "chat.completion.chunk",
    created: options.created,
    model: "bash-agent",
    choices: [{ index: 0, delta, finish_reason: options.finishReason ?? null }],
  };

  if (options.stopReason) {
    payload.acp = { stopReason: options.stopReason };
  }
  if (options.event) {
    payload.acp = { ...(payload.acp as Record<string, unknown> | undefined), event: options.event };
  }

  return payload;
}

/**
 * Creates an SSE response that streams events from `turn` to the caller.
 *
 * If the turn is already complete the buffered events are flushed immediately.
 * If it is still running the caller subscribes as a listener and receives
 * events in real-time until the turn finishes.
 *
 * Cancelling the stream (client disconnect) does NOT abort the agent; the
 * turn stays alive so the next request can reconnect.
 */
function createStreamingResponse(turn: ActiveChatTurn): Response {
  const encoder = new TextEncoder();
  const id = `chatcmpl_${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  return new Response(
    new ReadableStream({
      async start(controller) {
        let closed = false;
        const send = (payload: Record<string, unknown> | "[DONE]") => {
          if (closed) return;
          const data =
            payload === "[DONE]"
              ? "data: [DONE]\n\n"
              : `data: ${JSON.stringify(payload)}\n\n`;
          try {
            controller.enqueue(encoder.encode(data));
          } catch {
            closed = true;
          }
        };
        const sendEvent = (event: AgentEvent) => {
          send(
            createChunkPayload({
              id,
              created,
              content: event.type === "text" ? event.text : undefined,
              event,
            }),
          );
        };
        const listener = (event: AgentEvent) => sendEvent(event);

        try {
          send(createChunkPayload({ id, created, role: "assistant" }));
          for (const event of turn.events) {
            sendEvent(event);
          }
          if (!turn.result && !turn.error) {
            turn.listeners.add(listener);
            await turn.promise;
          }

          if (turn.error) {
            send({ error: turn.error });
            send("[DONE]");
            return;
          }
          send(
            createChunkPayload({
              id,
              created,
              finishReason: "stop",
              stopReason: turn.result?.stopReason,
            }),
          );
          send("[DONE]");
        } catch (error) {
          send({ error: error instanceof Error ? error.message : "Agent request failed" });
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
  messages: NormalizedChatMessage[];
  apiUrl: string;
  spaceId: string;
  documentId?: string;
  jobToken: string;
  shellSnapshot?: string | null;
}): ActiveChatTurn {
  const existing = activeChatTurns.get(options.key);
  if (existing) {
    existing.updatedAt = Date.now();
    return existing;
  }

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
        try {
          await persistCompletedChatTurn({
            spaceId: options.spaceId,
            chatId: options.chatId,
            userId: options.userId,
            requestMessages: options.messages,
            events: turn.events,
            result,
          });
        } catch {
          // The connected client also persists the final session when present.
        }
      }
    })
    .catch((error) => {
      turn.error = error instanceof Error ? error.message : "Agent request failed";
      turn.updatedAt = Date.now();
    })
    .finally(() => {
      scheduleActiveTurnCleanup(options.key, turn);
    });

  return turn;
}

export const POST: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      const body = await parseJsonBody<AcpRequestBody>(context.request);

      if (!Array.isArray(body.messages)) {
        return badRequestResponse("messages is required");
      }
      if (!body.chatId || typeof body.chatId !== "string") {
        return badRequestResponse("chatId is required");
      }
      if (!body.spaceId || typeof body.spaceId !== "string") {
        return badRequestResponse("spaceId is required");
      }
      if (body.documentId !== undefined && typeof body.documentId !== "string") {
        return badRequestResponse("documentId must be a string");
      }

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
        if (headerSpaceId !== body.spaceId) {
          return badRequestResponse("spaceId does not match job token scope");
        }
        const parsed = parseJobToken(providedJobToken, body.spaceId);
        if (!parsed) {
          throw unauthorizedResponse();
        }
        jobToken = providedJobToken;
      } else {
        const user = requireUser(context);
        await verifySpaceRole(body.spaceId, user.id, "viewer");
        userId = user.id;
        jobToken = createJobToken(body.spaceId, Date.now().toString(), user.id);
      }

      const messages = normalizeMessages(body.messages);
      const persistedSession =
        userId === null
          ? null
          : await getAIChatSession(body.spaceId, body.chatId, userId);

      // Base options shared by both streaming and non-streaming paths.
      // Note: the request AbortSignal is intentionally excluded here; it is
      // only applied to the non-streaming (synchronous) path so that client
      // disconnects during a streaming turn do not abort the agent worker.
      const workerOptions = {
        chatId: body.chatId,
        messages,
        apiUrl: getLocalOrigin(),
        spaceId: body.spaceId,
        documentId: body.documentId,
        jobToken,
        shellSnapshot: persistedSession?.shellSnapshot ?? null,
      };

      if (body.stream) {
        const key = getActiveTurnKey({ spaceId: body.spaceId, userId, chatId: body.chatId, messages });
        const turn = getOrStartActiveChatTurn({ key, userId, ...workerOptions });
        return createStreamingResponse(turn);
      }

      const nonStreamingEvents: AgentEvent[] = [];
      const result = await runAgentInWorker({
        ...workerOptions,
        signal: context.request.signal,
        onEvent: (event) => { nonStreamingEvents.push(event); },
      });
      if (userId !== null) {
        await persistCompletedChatTurn({
          spaceId: body.spaceId,
          chatId: body.chatId,
          userId,
          requestMessages: messages,
          events: nonStreamingEvents,
          result,
        });
      }
      return Response.json({
        id: `chatcmpl_${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "bash-agent",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: result.content },
            finish_reason: "stop",
          },
        ],
        acp: { stopReason: result.stopReason },
      });
    },
    {
      fallbackMessage: "Agent request failed",
      onError: (error) =>
        errorResponse(error instanceof Error ? error.message : "Agent request failed", 500),
    },
  );

/**
 * Cancels an active agent turn identified by the same (spaceId, chatId,
 * messages) triple used when starting it.  Aborting is idempotent — if the
 * turn has already finished or does not exist the request still succeeds.
 *
 * The client should fire this before closing the SSE stream so the server
 * can distinguish an intentional cancel from an accidental disconnect.
 */
export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      const body = await parseJsonBody<AcpRequestBody>(context.request);

      if (!Array.isArray(body.messages)) {
        return badRequestResponse("messages is required");
      }
      if (!body.chatId || typeof body.chatId !== "string") {
        return badRequestResponse("chatId is required");
      }
      if (!body.spaceId || typeof body.spaceId !== "string") {
        return badRequestResponse("spaceId is required");
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
        if (headerSpaceId !== body.spaceId) {
          return badRequestResponse("spaceId does not match job token scope");
        }
      } else {
        const user = requireUser(context);
        await verifySpaceRole(body.spaceId, user.id, "viewer");
        userId = user.id;
      }

      const messages = normalizeMessages(body.messages);
      const key = getActiveTurnKey({ spaceId: body.spaceId, userId, chatId: body.chatId, messages });
      const turn = activeChatTurns.get(key);
      if (turn) {
        turn.abort();
        activeChatTurns.delete(key);
      }

      return Response.json({ cancelled: true });
    },
    { fallbackMessage: "Cancel failed" },
  );
