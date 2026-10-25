import { parseAcpUpdate } from "#agent/acpUpdates.ts";
import type { AgentEvent } from "#agent/core.ts";

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
 * Sends a streaming JSON-RPC request to the ACP endpoint and maps the
 * `session/update` notifications it streams back to agent events.
 *
 * `session/prompt` starts a turn in a server-side session and streams it;
 * `session/load` attaches to the session's running turn, replaying it so far.
 * The server holds the conversation; a prompt carries only the new message.
 */
export async function fetchStreamingCompletion(options: {
  url: string;
  method: "session/prompt" | "session/load";
  params: { sessionId: string; spaceId: string } & Record<string, unknown>;
  onEvent?: (event: AgentEvent) => void;
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
      method: options.method,
      params: options.params,
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`ACP error ${response.status}: ${await response.text()}`);
  }
  if (!response.body) throw new Error("No response body");

  let stopReason = "end_turn";
  const toolNames = new Map<string, string>();

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

    const event = parseAcpUpdate(update, toolNames);
    if (event) options.onEvent?.(event);
  }

  return { stopReason };
}
