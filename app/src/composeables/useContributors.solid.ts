import { createEffect, createSignal } from "solid-js";
import { api, type DocumentContributor } from "#api/client.ts";
import { useSpace } from "./useSpace.solid.ts";

export function useContributors(documentId?: string) {
  const { currentSpaceId } = useSpace();
  const [contributors, setContributors] = createSignal<DocumentContributor[]>([]);
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function fetchContributors(): Promise<void> {
    const spaceId = currentSpaceId();
    if (!spaceId || !documentId) return;

    setIsLoading(true);
    setError(null);

    try {
      setContributors(await api.documentContributors.get(spaceId, documentId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  }

  createEffect(() => {
    if (currentSpaceId() && documentId) void fetchContributors();
  });

  return { contributors, isLoading, error, fetchContributors };
}
