import { createSignal } from "solid-js";
import {
  api,
  type RevisionMetadata,
  type RevisionSuggestionStatus,
  type RevisionWithContent,
} from "#api/client.ts";
import { useSpace } from "./useSpace.solid.ts";

export type RevisionStatus = "idle" | "saving" | "saved" | "error";

export function useRevisions(documentId: string | undefined) {
  const { currentSpaceId } = useSpace();
  const [revisions, setRevisions] = createSignal<RevisionMetadata[]>([]);
  const [isLoading, setIsLoading] = createSignal<boolean>(false);
  const [error, setError] = createSignal<string | null>(null);
  const [saveStatus, setSaveStatus] = createSignal<RevisionStatus>("idle");

  async function saveRevision(
    html: string,
    message?: string,
    mode: "revision" | "suggestion" = "revision",
  ): Promise<RevisionMetadata | null> {
    const spaceId = currentSpaceId();
    if (!spaceId) {
      throw new Error("No space selected");
    }

    if (!documentId) {
      return null;
    }

    setSaveStatus("saving");
    setError(null);

    try {
      const revision = await api.document.post(spaceId, documentId, {
        html,
        message,
        mode,
      });

      setSaveStatus("saved");

      setTimeout(() => {
        if (saveStatus() === "saved") {
          setSaveStatus("idle");
        }
      }, 2000);

      await fetchHistory();

      return revision as unknown as RevisionMetadata;
    } catch (err) {
      setSaveStatus("error");
      setError(err instanceof Error ? err.message : "Unknown error");
      return null;
    }
  }

  async function publishRevision(rev: number): Promise<boolean> {
    const spaceId = currentSpaceId();
    if (!spaceId) {
      throw new Error("No space selected");
    }

    if (!documentId) {
      throw new Error("No document selected");
    }

    try {
      await api.document.patch(spaceId, documentId, { publishedRev: rev });

      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      return false;
    }
  }

  async function fetchHistory(): Promise<void> {
    const spaceId = currentSpaceId();
    if (!spaceId) {
      return;
    }

    if (!documentId) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      setRevisions(await api.documentHistory.get(spaceId, documentId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  }

  async function updateRevisionStatus(
    rev: number,
    status: RevisionSuggestionStatus,
  ): Promise<RevisionMetadata | null> {
    const spaceId = currentSpaceId();
    if (!spaceId) {
      throw new Error("No space selected");
    }

    if (!documentId) {
      throw new Error("No document selected");
    }

    try {
      const updatedRevision = await api.documentHistory.patch(spaceId, documentId, rev, {
        status,
      });
      setRevisions(
        revisions().map((revision) =>
          revision.rev === updatedRevision.rev ? updatedRevision : revision,
        ),
      );
      return updatedRevision;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      return null;
    }
  }

  async function getRevision(rev: number): Promise<RevisionWithContent | null> {
    const spaceId = currentSpaceId();
    if (!spaceId) {
      throw new Error("No space selected");
    }

    if (!documentId) {
      throw new Error("No document selected");
    }

    try {
      const document = await api.document.get(spaceId, documentId, { rev });
      return document as unknown as RevisionWithContent;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      return null;
    }
  }

  return {
    revisions,
    isLoading,
    error,
    saveStatus,
    saveRevision,
    publishRevision,
    fetchHistory,
    updateRevisionStatus,
    getRevision,
  };
}
