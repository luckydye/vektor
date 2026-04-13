import type { ChatMessage, OpenRouterTool, ToolCall } from "../types.ts";

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

export async function fetchStreamingCompletion(options: {
  url: string;
  model: string;
  history: ChatMessage[];
  onDelta: (text: string) => void;
  tools?: readonly OpenRouterTool[];
  body?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<{ content: string; reasoning?: string; toolCalls?: ToolCall[] }> {
  const response = await fetch(options.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(options.body ?? {}),
      model: options.model,
      messages: options.history,
      tools: options.tools,
      stream: true,
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`);
  }

  if (!response.body) throw new Error("No response body");

  let content = "";
  let reasoning = "";
  const toolCallsMap = new Map<number, ToolCall>();

  for await (const chunk of parseSSEStream(response.body)) {
    const error = chunk.error;
    if (typeof error === "string" && error) {
      throw new Error(error);
    }

    const delta = (chunk as any).choices?.[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      content += delta.content;
      options.onDelta(delta.content);
    }
    if (delta.reasoning) {
      reasoning += delta.reasoning;
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls as any[]) {
        const idx = tc.index as number;
        const existing = toolCallsMap.get(idx);
        if (!existing) {
          toolCallsMap.set(idx, {
            id: tc.id ?? "",
            type: tc.type ?? "function",
            function: {
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            },
          });
        } else if (tc.function?.arguments) {
          existing.function.arguments += tc.function.arguments;
        }
      }
    }
  }

  const toolCalls =
    toolCallsMap.size > 0
      ? [...toolCallsMap.entries()].sort(([a], [b]) => a - b).map(([, v]) => v)
      : [];

  return {
    content: content || reasoning,
    reasoning: content ? reasoning || undefined : undefined,
    toolCalls,
  };
}
