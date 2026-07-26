import type { ChatMessage } from "./types.ts";
import { type PartialToolCall, parseSSE } from "./utils.ts";

/**
 * Providers that speak the OpenAI `/chat/completions` wire format. They share
 * a single streaming implementation and only differ by base URL.
 *
 * - `openai`: https://api.openai.com — OpenAI's first-party API
 * - `openrouter`: https://openrouter.ai
 * - `opencode-zen`: https://opencode.ai/zen — the opencode Zen model gateway
 */
export type OpenAICompatibleProvider = {
  provider: "openai" | "openrouter" | "opencode-zen";
  apiKey: string;
  model: string;
};

const CHAT_COMPLETIONS_URLS: Record<OpenAICompatibleProvider["provider"], string> = {
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  "opencode-zen": "https://opencode.ai/zen/v1/chat/completions",
};

export function getOpenAICompatibleChatCompletionsUrl(
  provider: OpenAICompatibleProvider,
): string {
  return CHAT_COMPLETIONS_URLS[provider.provider];
}

export function getOpenAICompatibleHeaders(
  provider: OpenAICompatibleProvider,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.apiKey}`,
  };
}

/** Converts stored chat history to the OpenAI Responses API input shape. */
export function toOpenAIResponsesInput(messages: ChatMessage[]): unknown[] {
  const input: unknown[] = [];

  for (const message of messages) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content ?? "",
      });
      continue;
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      if (message.content) {
        input.push({
          role: "assistant",
          content: [{ type: "output_text", text: message.content }],
        });
      }
      for (const toolCall of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        });
      }
      continue;
    }

    const role = message.role === "system" ? "developer" : message.role;
    const content: Array<Record<string, unknown>> = [];
    if (message.content) {
      content.push({
        type: message.role === "assistant" ? "output_text" : "input_text",
        text: message.content,
      });
    }
    for (const image of message.images ?? []) {
      content.push({
        type: "input_image",
        image_url: `data:${image.mediaType};base64,${image.data}`,
      });
    }
    input.push({ role, content });
  }

  return input;
}

function toOpenAIResponsesTools(tools: unknown[]): unknown[] {
  return tools.map((tool) => {
    const functionTool = tool as {
      type?: string;
      function?: { name?: string; description?: string; parameters?: unknown };
    };
    if (functionTool.type !== "function" || !functionTool.function?.name) return tool;
    return {
      type: "function",
      name: functionTool.function.name,
      description: functionTool.function.description,
      parameters: functionTool.function.parameters,
    };
  });
}

/** Removes Vektor-only fields and emits OpenAI's multimodal message format. */
export function toOpenAICompatibleMessages(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  return messages.map(({ images, imageAttachments: _imageAttachments, ...message }) => {
    if (!images?.length) return message;

    const content: Array<Record<string, unknown>> = [];
    if (message.content) content.push({ type: "text", text: message.content });
    for (const image of images) {
      content.push({
        type: "image_url",
        image_url: { url: `data:${image.mediaType};base64,${image.data}` },
      });
    }
    return { ...message, content };
  });
}

export async function callOpenAICompatible(options: {
  provider: OpenAICompatibleProvider;
  messages: ChatMessage[];
  tools: unknown[];
  signal?: AbortSignal;
  onText?: (text: string) => void | Promise<void>;
}): Promise<{ message: ChatMessage; finishReason: string }> {
  const response = await fetch(getOpenAICompatibleChatCompletionsUrl(options.provider), {
    method: "POST",
    headers: getOpenAICompatibleHeaders(options.provider),
    body: JSON.stringify({
      model: options.provider.model,
      messages: toOpenAICompatibleMessages(options.messages),
      tools: options.tools,
      stream: true,
    }),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `${options.provider.provider} ${response.status}: ${await response.text()}`,
    );
  }

  const pendingCalls = new Map<number, PartialToolCall>();
  let content = "";
  let finishReason = "stop";

  for await (const chunk of parseSSE(response.body)) {
    const choices = chunk.choices as
      | Array<{
          delta: {
            content?: string | null;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }>
      | undefined;

    if (!choices?.length) continue;
    const { delta, finish_reason } = choices[0]!;

    if (finish_reason) finishReason = finish_reason;

    if (delta.content) {
      content += delta.content;
      await options.onText?.(delta.content);
    }

    for (const tc of delta.tool_calls ?? []) {
      let pending = pendingCalls.get(tc.index);
      if (!pending) {
        pending = {
          id: tc.id ?? "",
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "",
        };
        pendingCalls.set(tc.index, pending);
      } else {
        if (tc.id) pending.id = tc.id;
        if (tc.function?.name) pending.name += tc.function.name;
        if (tc.function?.arguments) pending.arguments += tc.function.arguments;
      }
    }
  }

  const toolCalls = [...pendingCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));

  return {
    message: {
      role: "assistant",
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
    finishReason,
  };
}

/** Calls a Zen GPT model, which Zen exposes through the OpenAI Responses API. */
export async function callOpenAIResponses(options: {
  provider: OpenAICompatibleProvider;
  messages: ChatMessage[];
  tools: unknown[];
  signal?: AbortSignal;
  onText?: (text: string) => void | Promise<void>;
}): Promise<{ message: ChatMessage; finishReason: string }> {
  const response = await fetch("https://opencode.ai/zen/v1/responses", {
    method: "POST",
    headers: getOpenAICompatibleHeaders(options.provider),
    body: JSON.stringify({
      model: options.provider.model,
      input: toOpenAIResponsesInput(options.messages),
      tools: toOpenAIResponsesTools(options.tools),
      stream: true,
    }),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `${options.provider.provider} ${response.status}: ${await response.text()}`,
    );
  }

  let content = "";
  let completedResponse: Record<string, unknown> | undefined;
  for await (const chunk of parseSSE(response.body)) {
    if (chunk.type === "response.output_text.delta" && typeof chunk.delta === "string") {
      content += chunk.delta;
      await options.onText?.(chunk.delta);
    }
    if (chunk.type === "response.completed" && chunk.response) {
      completedResponse = chunk.response as Record<string, unknown>;
    }
  }

  const output = Array.isArray(completedResponse?.output)
    ? (completedResponse.output as Array<Record<string, unknown>>)
    : [];
  const toolCalls = output
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      id: String(item.call_id ?? ""),
      type: "function" as const,
      function: {
        name: String(item.name ?? ""),
        arguments: String(item.arguments ?? "{}"),
      },
    }));

  return {
    message: {
      role: "assistant",
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
    finishReason: toolCalls.length ? "tool_calls" : "stop",
  };
}
