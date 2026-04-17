import type { APIRoute } from "astro";
import {
  errorResponse,
  parseJsonBody,
  unauthorizedResponse,
  withApiErrorHandling,
} from "#db/api.ts";
import { verifyJobToken } from "../../../../jobs/jobToken.ts";
import {
  getAIProvider,
  getOpenAICompatibleChatCompletionsUrl,
} from "../../../../agent/core.ts";

export const POST: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      if (!context.locals.user) {
        const jobToken = context.request.headers.get("X-Job-Token");
        const spaceId = context.request.headers.get("X-Space-Id");
        if (!jobToken || !spaceId || !verifyJobToken(jobToken, spaceId)) {
          throw unauthorizedResponse();
        }
      }

      const provider = getAIProvider();
      const bodyJson = await parseJsonBody(context.request);

      if (provider.provider === "anthropic") {
        return proxyToAnthropic(provider.apiKey, provider.model, bodyJson, context.request.signal);
      }
      if (provider.provider === "ollama") {
        return proxyToOllama(provider.baseUrl, provider.model, bodyJson, context.request.signal);
      }

      bodyJson.model = provider.model;
      const response = await fetch(getOpenAICompatibleChatCompletionsUrl(provider), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(bodyJson),
        signal: context.request.signal,
      });

      return new Response(response.body, {
        status: response.status,
        headers: {
          "Content-Type": response.headers.get("Content-Type") ?? "application/json",
          "Cache-Control": "no-cache",
        },
      });
    },
    {
      fallbackMessage: "Proxy request failed",
      onError: () => errorResponse("Proxy request failed", 500),
    },
  );

type OpenAIMessage = { role: string; content: string | null; tool_call_id?: string; tool_calls?: unknown[] };

async function* parseNDJSONStream(
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

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        yield JSON.parse(trimmed) as Record<string, unknown>;
      }
    }

    const tail = buffer.trim();
    if (tail) {
      yield JSON.parse(tail) as Record<string, unknown>;
    }
  } finally {
    reader.releaseLock();
  }
}

function toAnthropicRequestBody(model: string, body: Record<string, unknown>): Record<string, unknown> {
  const messages = (body.messages as OpenAIMessage[] | undefined) ?? [];
  const systemParts: string[] = [];
  const anthropicMessages: Array<{ role: "user" | "assistant"; content: string | unknown[] }> = [];

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
      while (i < messages.length && messages[i]!.role === "tool") {
        const m = messages[i]!;
        toolResults.push({ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content ?? "" });
        i++;
      }
      anthropicMessages.push({ role: "user", content: toolResults });
      continue;
    }
    if (msg.role === "assistant") {
      const content: unknown[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const tc of (msg.tool_calls ?? []) as Array<{ id: string; function: { name: string; arguments: string } }>) {
        let input: unknown;
        try { input = JSON.parse(tc.function.arguments || "{}"); } catch { input = {}; }
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      anthropicMessages.push({ role: "assistant", content: content.length === 1 && !msg.tool_calls?.length ? (msg.content ?? "") : content });
      i++;
      continue;
    }
    anthropicMessages.push({ role: "user", content: msg.content ?? "" });
    i++;
  }

  const tools = (body.tools as Array<{ function: { name: string; description?: string; parameters: unknown } }> | undefined) ?? [];

  const result: Record<string, unknown> = {
    model,
    max_tokens: 8192,
    messages: anthropicMessages,
    stream: body.stream ?? false,
  };
  if (systemParts.length) result.system = systemParts.join("\n\n");
  if (tools.length) result.tools = tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  return result;
}

async function proxyToAnthropic(
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
    return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json" } });
  }

  if (!body.stream) {
    const data = await response.json() as {
      id: string;
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason: string;
    };
    const textContent = data.content.filter(b => b.type === "text").map(b => b.text ?? "").join("");
    const toolCalls = data.content
      .filter(b => b.type === "tool_use")
      .map(b => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
    return Response.json({
      id: data.id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: textContent || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: data.stop_reason === "tool_use" ? "tool_calls" : "stop",
      }],
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

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finishReason: string | null = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop()!;
          for (const part of parts) {
            for (const line of part.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const chunk = JSON.parse(line.slice(6)) as { type?: string; delta?: { type?: string; text?: string; stop_reason?: string } };
                if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta" && chunk.delta.text) {
                  send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: chunk.delta.text }, finish_reason: null }] });
                } else if (chunk.type === "message_delta" && chunk.delta?.stop_reason) {
                  finishReason = chunk.delta.stop_reason === "tool_use" ? "tool_calls" : "stop";
                }
              } catch { /* skip malformed */ }
            }
          }
        }
        send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason ?? "stop" }] });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

async function proxyToOllama(
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
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(ollamaBody),
    signal,
  });

  if (!response.ok) {
    return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json" } });
  }

  if (!body.stream) {
    const data = await response.json() as {
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
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: data.message?.content ?? null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : data.done_reason ?? "stop",
      }],
      acp: data.message?.thinking ? { event: { type: "thinking", text: data.message.thinking } } : undefined,
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
        for await (const chunk of parseNDJSONStream(response.body!)) {
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
              choices: [{ index: 0, delta: { content: message.content }, finish_reason: null }],
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
