import { createSignal } from "solid-js";
import { api, type UserSshKey } from "#api/client.ts";
import { useTranslation } from "./useTranslation.ts";

/**
 * The caller's registered SSH keys. Nothing secret passes through here — a key
 * is public, and what it buys is a login, so the list is loaded and mutated
 * plainly rather than held like a token secret.
 */
export function useUserSshKeys() {
  const t = useTranslation();
  const [keys, setKeys] = createSignal<UserSshKey[]>([]);
  // Starts true so the list shows loading rather than "no keys" before the
  // first load runs — the caller loads lazily, when the tab is opened.
  const [isLoading, setIsLoading] = createSignal(true);
  const [isAdding, setIsAdding] = createSignal(false);
  const [pendingKeyId, setPendingKeyId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  function message(cause: unknown, fallback: string): string {
    return cause instanceof Error ? cause.message : fallback;
  }

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.sshKeys.get();
      setKeys(response.keys || []);
    } catch (cause) {
      setError(message(cause, t("Failed to load SSH keys")));
      setKeys([]);
    } finally {
      setIsLoading(false);
    }
  }

  async function add(input: { publicKey: string; name: string }): Promise<boolean> {
    setIsAdding(true);
    setError(null);
    try {
      // The server rejects a malformed key with a message written for whoever
      // pasted it, so there is nothing to validate here first.
      await api.sshKeys.create({
        publicKey: input.publicKey.trim(),
        ...(input.name.trim() ? { name: input.name.trim() } : {}),
      });
      await load();
      return true;
    } catch (cause) {
      setError(message(cause, t("Failed to add SSH key")));
      return false;
    } finally {
      setIsAdding(false);
    }
  }

  async function remove(keyId: string) {
    setPendingKeyId(keyId);
    setError(null);
    try {
      await api.sshKeys.delete(keyId);
      await load();
    } catch (cause) {
      setError(message(cause, t("Failed to delete SSH key")));
    } finally {
      setPendingKeyId(null);
    }
  }

  return { keys, isLoading, isAdding, pendingKeyId, error, load, add, remove };
}
