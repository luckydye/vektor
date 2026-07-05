import type { ChatStreamEvent } from "#components/ai-chat/types.ts";

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop()!;

      for (const part of parts) {
        for (const line of part.split("\n")) {
          if (line.startsWith("data: ")) {
            const payload = line.slice(6);
            if (payload === "[DONE]") return;
            try {
              yield JSON.parse(payload) as Record<string, unknown>;
            } catch {
              // skip malformed JSON
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Sends a JSON-RPC `session/prompt` request to the ACP endpoint and streams
 * back `session/update` notifications, mapping each to a `ChatStreamEvent`.
 *
 * Request format (Agent Client Protocol):
 *   { jsonrpc: "2.0", id, method: "session/prompt",
 *     params: { sessionId, spaceId, documentId?, prompt: [{type:"text",text}] } }
 *
 * The server manages conversation history; the caller only provides the new
 * user message.
 */
export async function fetchStreamingCompletion(options: {
  url: string;
  sessionId: string;
  spaceId: string;
  documentId?: string;
  userMessage: string;
  onEvent?: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
}): Promise<{ stopReason: string }> {
  const requestId = crypto.randomUUID();

  const response = await fetch(options.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "session/prompt",
      params: {
        sessionId: options.sessionId,
        spaceId: options.spaceId,
        documentId: options.documentId,
        prompt: [{ type: "text", text: options.userMessage }],
      },
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`ACP error ${response.status}: ${await response.text()}`);
  }
  if (!response.body) throw new Error("No response body");

  let stopReason = "end_turn";

  for await (const chunk of parseSSEStream(response.body)) {
    // JSON-RPC error
    if (chunk.error && typeof chunk.error === "object") {
      const err = chunk.error as Record<string, unknown>;
      throw new Error(typeof err.message === "string" ? err.message : "ACP error");
    }

    // Final session/prompt result: { jsonrpc, id, result: { stopReason } }
    if (chunk.id === requestId && chunk.result && typeof chunk.result === "object") {
      const result = chunk.result as Record<string, unknown>;
      if (typeof result.stopReason === "string") {
        stopReason = result.stopReason;
      }
      continue;
    }

    // session/update notification
    if (chunk.method !== "session/update") continue;
    const params = chunk.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    if (!update) continue;

    const kind = update.sessionUpdate as string;

    if (kind === "agent_message_chunk") {
      const content = update.content as Record<string, unknown> | undefined;
      if (content?.type === "text" && typeof content.text === "string") {
        options.onEvent?.({ type: "text", text: content.text });
      }
      continue;
    }

    if (kind === "generic") {
      const generic = update.generic as Record<string, unknown> | undefined;
      if (generic?.type === "thinking" && typeof generic.text === "string") {
        options.onEvent?.({ type: "thinking", text: generic.text });
      }
      continue;
    }

    if (kind === "plan") {
      const entries = update.entries as Array<Record<string, unknown>> | undefined;
      const first = entries?.[0];
      if (typeof first?.content === "string") {
        options.onEvent?.({ type: "status", text: first.content });
      }
      continue;
    }

    if (kind === "tool_call") {
      const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
      const toolName = typeof update.title === "string" ? update.title : "";
      const toolKind = typeof update.kind === "string" ? update.kind : "other";
      const input = update.input;
      const toolArguments =
        input !== undefined && input !== null ? JSON.stringify(input) : "{}";
      options.onEvent?.({
        type: "tool_call",
        toolCallId,
        toolName,
        toolArguments,
        kind: toolKind as import("../types.ts").ToolCallKind,
      });
      continue;
    }

    if (kind === "tool_call_update") {
      const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
      const toolName = typeof update.toolName === "string" ? update.toolName : "";
      const status = update.status as string;

      if (status === "in_progress") {
        options.onEvent?.({ type: "tool_progress", toolCallId, toolName });
        continue;
      }

      if (status === "completed" || status === "failed") {
        const contentArr = update.content as Array<Record<string, unknown>> | undefined;
        const first = contentArr?.[0];
        const innerContent = first?.content as Record<string, unknown> | undefined;
        const text = typeof innerContent?.text === "string" ? innerContent.text : "";
        options.onEvent?.({
          type: "tool_result",
          toolCallId,
          toolName,
          content: text,
          isError: status === "failed",
        });
      }
    }
  }

  return { stopReason };
}
