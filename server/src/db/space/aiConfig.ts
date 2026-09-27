import type { AIProvider } from "#api/provider/types.ts";

/** Provider credentials are supplied once by the instance operator. */
export function getAIProvider(): AIProvider {
  const provider = process.env.VEKTOR_AI_PROVIDER?.trim();
  const model = process.env.VEKTOR_AI_MODEL?.trim();
  if (!provider || !model) {
    throw new Error("AI provider is not configured for this instance.");
  }
  if (provider === "ollama") {
    const baseUrl = process.env.VEKTOR_AI_BASE_URL?.trim().replace(/\/+$/, "");
    if (!baseUrl) throw new Error("VEKTOR_AI_BASE_URL is required for Ollama.");
    return { provider, model, baseUrl };
  }
  if (
    provider === "anthropic" ||
    provider === "openai" ||
    provider === "openrouter" ||
    provider === "opencode-zen"
  ) {
    const apiKey = process.env.VEKTOR_AI_API_KEY?.trim();
    if (!apiKey) throw new Error("VEKTOR_AI_API_KEY is required for this AI provider.");
    return { provider, model, apiKey };
  }
  throw new Error(`Unknown VEKTOR_AI_PROVIDER: ${provider}`);
}

/** A missing cap defaults to one million estimated tokens per space per week. */
export function maxWeeklyAITokens(): number {
  const raw = process.env.VEKTOR_AI_WEEKLY_MAX_TOKENS;
  if (raw === undefined || raw === "") return 1_000_000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("VEKTOR_AI_WEEKLY_MAX_TOKENS must be a positive integer.");
  }
  return value;
}
