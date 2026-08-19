import { createSignal } from "solid-js";
import { api, type PersonalAccessToken } from "#api/client.ts";
import { t } from "#utils/lang.ts";

export interface CreatePersonalTokenInput {
  name: string;
  spaceId: string;
  expiresInDays: number | null;
}

/**
 * The caller's own access tokens. The secret of a freshly minted token is held
 * here until dismissed — the server hands it over once and never again.
 */
export function usePersonalAccessTokens() {
  const [tokens, setTokens] = createSignal<PersonalAccessToken[]>([]);
  // Starts true so the list shows loading rather than "no tokens" before the
  // first load runs — the caller loads lazily, when the tab is opened.
  const [isLoading, setIsLoading] = createSignal(true);
  const [isCreating, setIsCreating] = createSignal(false);
  const [pendingTokenId, setPendingTokenId] = createSignal<string | null>(null);
  const [createdToken, setCreatedToken] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  function message(cause: unknown, fallback: string): string {
    return cause instanceof Error ? cause.message : fallback;
  }

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.personalAccessTokens.get();
      setTokens(response.tokens || []);
    } catch (cause) {
      setError(message(cause, t("Failed to load access tokens")));
      setTokens([]);
    } finally {
      setIsLoading(false);
    }
  }

  async function create(input: CreatePersonalTokenInput): Promise<boolean> {
    setIsCreating(true);
    setError(null);
    try {
      const result = await api.personalAccessTokens.create({
        name: input.name.trim(),
        spaceId: input.spaceId,
        ...(input.expiresInDays ? { expiresInDays: input.expiresInDays } : {}),
      });
      setCreatedToken(result.token);
      await load();
      return true;
    } catch (cause) {
      setError(message(cause, t("Failed to create access token")));
      return false;
    } finally {
      setIsCreating(false);
    }
  }

  async function revoke(tokenId: string) {
    setPendingTokenId(tokenId);
    setError(null);
    try {
      await api.personalAccessTokens.revoke(tokenId);
      await load();
    } catch (cause) {
      setError(message(cause, t("Failed to revoke access token")));
    } finally {
      setPendingTokenId(null);
    }
  }

  async function remove(tokenId: string) {
    setPendingTokenId(tokenId);
    setError(null);
    try {
      await api.personalAccessTokens.delete(tokenId);
      await load();
    } catch (cause) {
      setError(message(cause, t("Failed to delete access token")));
    } finally {
      setPendingTokenId(null);
    }
  }

  return {
    tokens,
    isLoading,
    isCreating,
    pendingTokenId,
    createdToken,
    dismissCreatedToken: () => setCreatedToken(null),
    error,
    load,
    create,
    revoke,
    remove,
  };
}
