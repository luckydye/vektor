import { config } from "#config";
import {
  parseHttpUrl,
  resolvePublicUrl,
  SsrfError,
  safeFetch,
  type UrlValidator,
} from "#utils/ssrf.ts";
import type { ChatMessage } from "./types.ts";
import { type PartialToolCall, parseNDJSON } from "./utils.ts";

type OllamaProvider = { provider: "ollama"; baseUrl: string; model: string };

/**
 * Egress policy for a configured provider base URL.
 *
 * The base URL is space configuration, but the request it produces is made by
 * the server on behalf of *any viewer* and the upstream body is handed back
 * inside the completion — so an unchecked value is a read primitive against
 * loopback, the private ranges and the cloud metadata endpoint, not merely a
 * misconfiguration.
 *
 * Self-hosted Ollama is why this is a policy rather than a flat denylist: a
 * private base URL is the normal deployment for it. Private targets are allowed
 * only under `VEKTOR_JOB_FETCH_ALLOW_PRIVATE=1`, the same opt-in the job runtime
 * uses for private egress, which is off by default.
 */
export const resolveProviderUrl: UrlValidator = async (rawUrl) => {
  if (config().JOB_FETCH_ALLOW_PRIVATE !== "1") return await resolvePublicUrl(rawUrl);
  // No pinning under the hatch: its whole point is to reach names that resolve
  // into the local network.
  return { url: parseHttpUrl(rawUrl), addresses: [] };
};

/**
 * The absolute chat URL under a configured Ollama base URL.
 *
 * `${baseUrl}/api/chat` was concatenation, not resolution, and the two differ
 * exactly where it matters. A base ending in `#` or `?` swallowed the path
 * (`http://host/#` + `/api/chat` requests `/`, with the rest in the fragment), a
 * trailing slash produced `//api/chat`, and a base carrying userinfo or a query
 * ends up in a URL no one looked at as a whole. Here only the parsed base's path
 * grows, so the URL that gets checked is the URL that gets requested — and
 * {@link safeFetch} re-validates that final URL, not the base it came from.
 */
export function ollamaChatUrl(baseUrl: string): string {
  const url = parseHttpUrl(baseUrl.trim());
  if (url.username || url.password || url.search || url.hash) {
    throw new SsrfError(
      "Base URL must not contain credentials, a query string or a fragment",
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/chat`;
  // Both are empty here, so this only drops a bare trailing `?`/`#` delimiter.
  url.search = "";
  url.hash = "";
  return url.href;
}

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

    const result: Record<string, unknown> = {
      role: message.role,
      content: message.content ?? "",
    };
    if (message.images?.length) {
      result.images = message.images.map((image) => image.data);
    }
    return result;
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
  // `safeFetch` with the provider policy, never a bare `fetch`: the base URL is
  // stored configuration, so write-time validation cannot vouch for it here — the
  // value may predate the check and the name may resolve somewhere else now.
  const response = await safeFetch(
    ollamaChatUrl(options.provider.baseUrl),
    {
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
    },
    resolveProviderUrl,
  );

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
  // Ollama takes generation limits under `options`, and its own defaults (notably
  // num_ctx) clip long answers mid-sentence. Translate the OpenAI-shaped output
  // cap so callers can raise it the same way they do for other providers.
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;

  const ollamaBody = {
    model,
    messages: body.messages,
    tools: body.tools,
    stream: body.stream ?? false,
    think: true,
    ...(typeof maxTokens === "number" ? { options: { num_predict: maxTokens } } : {}),
  };

  const response = await safeFetch(
    ollamaChatUrl(baseUrl),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ollamaBody),
      signal,
    },
    resolveProviderUrl,
  );

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

      let finishReason: string | null = null;

      try {
        for await (const chunk of parseNDJSON(response.body!)) {
          const message = (chunk.message as Record<string, unknown> | undefined) ?? {};
          if (typeof chunk.done_reason === "string") finishReason = chunk.done_reason;
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
