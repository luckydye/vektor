/**
 * Space preference keys holding the AI provider config. Shared so the client
 * can tell whether a space has an agent from the space payload it already has
 * (`Space.preferences`) — the provider config itself is editor-only, but the
 * agent is usable by viewers.
 */
export const AI_PROVIDER_KEY = "ai:provider";
export const AI_MODEL_KEY = "ai:model";
export const AI_BASE_URL_KEY = "ai:baseUrl";

export const AI_PREF_KEYS = [AI_PROVIDER_KEY, AI_MODEL_KEY, AI_BASE_URL_KEY];

/** An agent is available once a provider and a model are set for the space. */
export function isAIProviderConfigured(
  preferences: Record<string, string> | undefined,
): boolean {
  return !!preferences?.[AI_PROVIDER_KEY] && !!preferences?.[AI_MODEL_KEY];
}
