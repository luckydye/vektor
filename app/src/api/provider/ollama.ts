import type { ChatMessage } from "./types.ts";
import { type PartialToolCall, parseNDJSON } from "./utils.ts";

type OllamaProvider = { provider: "ollama"; baseUrl: string; model: string };

export function toOllamaMessages(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  const toolNames = new Map<string, string>();

  return messages.map((message) => {
    if (message.role === "assistant") {
      const toolCalls = (message.tool_calls ?? []).map((toolCall, index) => {
        let parsedArguments: unknown;
        try {
          parsedArguments = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          parsedArguments = {};
        }

        toolNames.set(toolCall.id, toolCall.function.name);
        return {
          type: "function",
          function: {
            index,
            name: toolCall.function.name,
            arguments: parsedArguments,
          },
        };
      });

      const result: Record<string, unknown> = { role: "assistant" };
      if (message.content) result.content = message.content;
      if (message.thinking) result.thinking = message.thinking;
      if (toolCalls.length > 0) result.tool_calls = toolCalls;
      return result;
    }

    if (message.role === "tool") {
      if (!message.tool_call_id) {
        throw new Error("Ollama tool message is missing tool_call_id.");
      }
      const toolName = toolNames.get(message.tool_call_id);
      if (!toolName) {
        throw new Error(
          `Ollama tool message references unknown tool_call_id: ${message.tool_call_id}`,
        );
      }
      return {
        role: "tool",
        tool_name: toolName,
        content: message.content ?? "",
      };
    }

    return {
      role: message.role,
      content: message.content ?? "",
    };
  });
}

export async function callOllama(options: {
  provider: OllamaProvider;
  messages: ChatMessage[];
  tools: unknown[];
  signal?: AbortSignal;
  onText?: (text: string) => void | Promise<void>;
  onThinking?: (text: string) => void | Promise<void>;
}): Promise<{ message: ChatMessage; finishReason: string }> {
  const response = await fetch(`${options.provider.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: options.provider.model,
      messages: toOllamaMessages(options.messages),
      tools: options.tools,
      stream: true,
      think: true,
    }),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Ollama ${response.status}: ${await response.text()}`);
  }

  const pendingCalls = new Map<number, PartialToolCall>();
  let content = "";
  let thinking = "";
  let finishReason = "stop";

  for await (const chunk of parseNDJSON(response.body)) {
    const message = (chunk.message as Record<string, unknown> | undefined) ?? {};
    const thinkingDelta = typeof message.thinking === "string" ? message.thinking : "";
    const contentDelta = typeof message.content === "string" ? message.content : "";
    if (thinkingDelta) {
      thinking += thinkingDelta;
      await options.onThinking?.(thinkingDelta);
    }
    if (contentDelta) {
      content += contentDelta;
      await options.onText?.(contentDelta);
    }

    const toolCalls = Array.isArray(message.tool_calls)
      ? (message.tool_calls as Array<{
          function?: { index?: number; name?: string; arguments?: unknown };
        }>)
      : [];
    for (const toolCall of toolCalls) {
      const index =
        typeof toolCall.function?.index === "number"
          ? toolCall.function.index
          : pendingCalls.size;
      const pending = pendingCalls.get(index) ?? {
        id: `ollama_tool_${index}_${crypto.randomUUID()}`,
        name: "",
        arguments: "",
      };
      if (toolCall.function?.name) pending.name = toolCall.function.name;
      if (toolCall.function?.arguments !== undefined) {
        pending.arguments = JSON.stringify(toolCall.function.arguments);
      }
      pendingCalls.set(index, pending);
    }

    if (chunk.done === true) {
      const doneReason = chunk.done_reason;
      if (typeof doneReason === "string" && doneReason) {
        finishReason = doneReason;
      } else if (pendingCalls.size > 0) {
        finishReason = "tool_calls";
      }
    }
  }

  const toolCalls = [...pendingCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, toolCall]) => ({
      id: toolCall.id,
      type: "function" as const,
      function: { name: toolCall.name, arguments: toolCall.arguments },
    }));

  return {
    message: {
      role: "assistant",
      content: content || null,
      thinking: thinking || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
    finishReason: toolCalls.length > 0 ? "tool_calls" : finishReason,
  };
}

export async function proxyToOllama(
  baseUrl: string,
  model: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const ollamaBody = {
    model,
    messages: body.messages,
    tools: body.tools,
    stream: body.stream ?? false,
    think: true,
  };

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ollamaBody),
    signal,
  });

  if (!response.ok) {
    return new Response(response.body, {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!body.stream) {
    const data = (await response.json()) as {
      message?: {
        content?: string;
        thinking?: string;
        tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
      };
      done_reason?: string;
    };
    const toolCalls = (data.message?.tool_calls ?? []).map((toolCall, index) => ({
      id: `ollama_tool_${index}_${crypto.randomUUID()}`,
      type: "function",
      function: {
        name: toolCall.function?.name ?? "",
        arguments: JSON.stringify(toolCall.function?.arguments ?? {}),
      },
    }));
    return Response.json({
      id: `chatcmpl_${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: data.message?.content ?? null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason:
            toolCalls.length > 0 ? "tool_calls" : (data.done_reason ?? "stop"),
        },
      ],
      acp: data.message?.thinking
        ? { event: { type: "thinking", text: data.message.thinking } }
        : undefined,
    });
  }

  const encoder = new TextEncoder();
  const id = `chatcmpl_${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      try {
        for await (const chunk of parseNDJSON(response.body!)) {
          const message = (chunk.message as Record<string, unknown> | undefined) ?? {};
          if (typeof message.thinking === "string" && message.thinking) {
            send({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: null }],
              acp: { event: { type: "thinking", text: message.thinking } },
            });
          }
          if (typeof message.content === "string" && message.content) {
            send({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                { index: 0, delta: { content: message.content }, finish_reason: null },
              ],
            });
          }
        }
        send({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
