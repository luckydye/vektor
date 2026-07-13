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
      messages: options.messages,
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
