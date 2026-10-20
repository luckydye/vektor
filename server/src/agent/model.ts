import { callAnthropic } from "#api/provider/anthropic.ts";
import { callOllama } from "#api/provider/ollama.ts";
import {
  callOpenAICompatible,
  callOpenAIResponses,
} from "#api/provider/openaiCompatible.ts";
import type { AIProvider, ChatMessage } from "#api/provider/types.ts";
import { estimateModelInput, estimateTokens } from "#db/space/aiUsage.ts";
import type { SafeFetch } from "#utils/ssrf.ts";

/** Settles a token reservation with what the call actually used. */
export type SettleAITokens = (actualTokens?: number) => Promise<void>;

export async function callModel(options: {
  fetch: SafeFetch;
  spaceId: string;
  provider: AIProvider;
  messages: ChatMessage[];
  tools: unknown[];
  signal?: AbortSignal;
  onText?: (text: string) => void | Promise<void>;
  onThinking?: (text: string) => void | Promise<void>;
  /** Reserves the call's tokens against the space's weekly budget. */
  reserveAITokens: (inputTokens: number) => Promise<SettleAITokens>;
}): Promise<{ message: ChatMessage; finishReason: string }> {
  // The space's weekly budget caps the instance's own provider; an
  // integration's usage is billed to the user's account instead.
  if (options.provider.provider === "integration") return callModelProvider(options);

  const inputTokens = estimateModelInput(options.messages, options.tools);
  const settle = await options.reserveAITokens(inputTokens);
  let output = "";
  let thinking = "";
  const trackedOptions = {
    ...options,
    onText: async (text: string) => {
      output += text;
      await options.onText?.(text);
    },
    onThinking: async (text: string) => {
      thinking += text;
      await options.onThinking?.(text);
    },
  };
  try {
    const result = await callModelProvider(trackedOptions);
    await settle(
      inputTokens +
        estimateTokens(result.message) +
        (result.message.thinking ? 0 : estimateTokens(thinking)),
    );
    return result;
  } catch (error) {
    await settle(
      output || thinking ? inputTokens + estimateTokens(output + thinking) : 0,
    );
    throw error;
  }
}

async function callModelProvider(
  options: Parameters<typeof callModel>[0],
): ReturnType<typeof callModel> {
  const provider = options.provider;
  if (
    provider.provider === "anthropic" ||
    (provider.provider === "opencode-zen" && isOpenCodeZenClaudeModel(provider.model))
  ) {
    return callAnthropic({ ...options, provider });
  }
  if (provider.provider === "ollama") {
    return callOllama({ ...options, provider });
  }
  if (provider.provider === "integration") {
    return callOpenAIResponses({
      ...options,
      label: provider.integration,
      url: provider.url,
      apiKey: await provider.accessToken(),
      model: provider.model,
      store: false,
    });
  }
  if (provider.provider === "opencode-zen" && isOpenCodeZenGPTModel(provider.model)) {
    return callOpenAIResponses({
      ...options,
      label: provider.provider,
      url: "https://opencode.ai/zen/v1/responses",
      apiKey: provider.apiKey,
      model: provider.model,
    });
  }
  if (
    provider.provider === "opencode-zen" &&
    isOpenCodeZenTextOnlyModel(provider.model)
  ) {
    const hasImages = options.messages.some((message) => message.images?.length);
    if (hasImages) {
      throw new Error(`${provider.model} does not support image input.`);
    }
  }
  return callOpenAICompatible({ ...options, provider });
}

/** Zen serves Claude models from its Anthropic-compatible `/messages` endpoint. */
export function isOpenCodeZenClaudeModel(model: string): boolean {
  return model.toLowerCase().startsWith("claude-");
}

/** Zen exposes GPT models through `/responses`, unlike its chat-completions models. */
export function isOpenCodeZenGPTModel(model: string): boolean {
  return model.toLowerCase().startsWith("gpt-");
}

/** Zen's GLM 5 series accepts text only; image blocks would be rejected upstream. */
export function isOpenCodeZenTextOnlyModel(model: string): boolean {
  return model.toLowerCase().startsWith("glm-");
}
