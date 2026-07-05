import type { ChatMessage } from "./types.ts";
import { type PartialToolCall, parseSSE } from "./utils.ts";

type AnthropicProvider = { provider: "anthropic"; apiKey: string; model: string };

export function toAnthropicMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: Array<{ role: "user" | "assistant"; content: string | unknown[] }>;
} {
  const systemParts: string[] = [];
  const result: Array<{ role: "user" | "assistant"; content: string | unknown[] }> = [];

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;

    if (msg.role === "system") {
      if (msg.content) systemParts.push(msg.content);
      i++;
      continue;
    }

    if (msg.role === "tool") {
      const toolResults: unknown[] = [];
      while (i < messages.length && messages[i]?.role === "tool") {
        const m = messages[i]!;
        toolResults.push({
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          content: m.content ?? "",
        });
        i++;
      }
      result.push({ role: "user", content: toolResults });
      continue;
    }

    if (msg.role === "assistant") {
      const content: unknown[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const tc of msg.tool_calls ?? []) {
        let input: unknown;
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          input = {};
        }
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      result.push({
        role: "assistant",
        content:
          content.length === 1 && !msg.tool_calls?.length ? (msg.content ?? "") : content,
      });
      i++;
      continue;
    }

    result.push({ role: "user", content: msg.content ?? "" });
    i++;
  }

  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: result,
  };
}

type OpenAIMessage = {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

export function toAnthropicRequestBody(
  model: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const messages = (body.messages as OpenAIMessage[] | undefined) ?? [];
  const systemParts: string[] = [];
  const anthropicMessages: Array<{
    role: "user" | "assistant";
    content: string | unknown[];
  }> = [];

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role === "system") {
      if (msg.content) systemParts.push(msg.content);
      i++;
      continue;
    }
    if (msg.role === "tool") {
      const toolResults: unknown[] = [];
      while (i < messages.length && messages[i]?.role === "tool") {
        const m = messages[i]!;
        toolResults.push({
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          content: m.content ?? "",
        });
        i++;
      }
      anthropicMessages.push({ role: "user", content: toolResults });
      continue;
    }
    if (msg.role === "assistant") {
      const content: unknown[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const tc of (msg.tool_calls ?? []) as Array<{
        id: string;
        function: { name: string; arguments: string };
      }>) {
        let input: unknown;
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          input = {};
        }
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      anthropicMessages.push({
        role: "assistant",
        content:
          content.length === 1 && !msg.tool_calls?.length ? (msg.content ?? "") : content,
      });
      i++;
      continue;
    }
    anthropicMessages.push({ role: "user", content: msg.content ?? "" });
    i++;
  }

  const tools =
    (body.tools as
      | Array<{ function: { name: string; description?: string; parameters: unknown } }>
      | undefined) ?? [];

  const result: Record<string, unknown> = {
    model,
    max_tokens: 8192,
    messages: anthropicMessages,
    stream: body.stream ?? false,
  };
  if (systemParts.length) result.system = systemParts.join("\n\n");
  if (tools.length)
    result.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  return result;
}

export async function callAnthropic(options: {
  provider: AnthropicProvider;
  messages: ChatMessage[];
  tools: unknown[];
  signal?: AbortSignal;
  onText?: (text: string) => void | Promise<void>;
}): Promise<{ message: ChatMessage; finishReason: string }> {
  const { system, messages: anthropicMessages } = toAnthropicMessages(options.messages);
  const anthropicTools = (
    options.tools as Array<{
      function: { name: string; description?: string; parameters: unknown };
    }>
  ).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  const body: Record<string, unknown> = {
    model: options.provider.model,
    max_tokens: 8192,
    messages: anthropicMessages,
    stream: true,
  };
  if (system) body.system = system;
  if (anthropicTools.length) body.tools = anthropicTools;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": options.provider.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Anthropic ${response.status}: ${await response.text()}`);
  }

  let textContent = "";
  let finishReason = "stop";
  const toolCalls: PartialToolCall[] = [];

  for await (const chunk of parseSSE(response.body)) {
    const type = (chunk as { type?: string }).type;

    if (type === "content_block_start") {
      const block = (
        chunk as { content_block?: { type: string; id?: string; name?: string } }
      ).content_block;
      if (block?.type === "tool_use") {
        toolCalls.push({ id: block.id ?? "", name: block.name ?? "", arguments: "" });
      }
    } else if (type === "content_block_delta") {
      const delta = (
        chunk as { delta?: { type?: string; text?: string; partial_json?: string } }
      ).delta;
      if (delta?.type === "text_delta" && delta.text) {
        textContent += delta.text;
        await options.onText?.(delta.text);
      } else if (
        delta?.type === "input_json_delta" &&
        delta.partial_json &&
        toolCalls.length > 0
      ) {
        toolCalls[toolCalls.length - 1]!.arguments += delta.partial_json;
      }
    } else if (type === "message_delta") {
      const stopReason = (chunk as { delta?: { stop_reason?: string } }).delta
        ?.stop_reason;
      if (stopReason === "tool_use") finishReason = "tool_calls";
      else if (stopReason) finishReason = stopReason;
    }
  }

  return {
    message: {
      role: "assistant",
      content: textContent || null,
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }
        : {}),
    },
    finishReason,
  };
}

export async function proxyToAnthropic(
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const anthropicBody = toAnthropicRequestBody(model, body);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(anthropicBody),
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
      id: string;
      content: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
      }>;
      stop_reason: string;
    };
    const textContent = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const toolCalls = data.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
    return Response.json({
      id: data.id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: textContent || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: data.stop_reason === "tool_use" ? "tool_calls" : "stop",
        },
      ],
    });
  }

  // Streaming: convert Anthropic SSE → OpenAI SSE
  const encoder = new TextEncoder();
  const id = `chatcmpl_${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      let finishReason: string | null = null;

      try {
        for await (const chunk of parseSSE(response.body!)) {
          const typed = chunk as {
            type?: string;
            delta?: { type?: string; text?: string; stop_reason?: string };
          };
          if (
            typed.type === "content_block_delta" &&
            typed.delta?.type === "text_delta" &&
            typed.delta.text
          ) {
            send({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: typed.delta.text },
                  finish_reason: null,
                },
              ],
            });
          } else if (typed.type === "message_delta" && typed.delta?.stop_reason) {
            finishReason = typed.delta.stop_reason === "tool_use" ? "tool_calls" : "stop";
          }
        }
        send({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason ?? "stop" }],
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
