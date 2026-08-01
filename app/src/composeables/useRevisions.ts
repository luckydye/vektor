import { createSignal } from "solid-js";
import {
  api,
  type RevisionMetadata,
  type RevisionSuggestionStatus,
  type RevisionWithContent,
} from "#api/client.ts";
import { access, type MaybeAccessor } from "./query.ts";
import { useSpace } from "./useSpace.ts";

export type RevisionStatus = "idle" | "saving" | "saved" | "error";

/**
 * The id is an accessor for the same reason `useDocument`'s is: a caller that
 * survives navigation would otherwise keep writing revisions to the document it
 * was created under.
 */
export function useRevisions(documentIdInput: MaybeAccessor<string | undefined>) {
  const documentId = () => access(documentIdInput);
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

    const docId = documentId();
    if (!docId) {
      return null;
    }

    setSaveStatus("saving");
    setError(null);

    try {
      const revision = await api.document.post(spaceId, docId, {
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

    const docId = documentId();
    if (!docId) {
      throw new Error("No document selected");
    }

    try {
      await api.document.patch(spaceId, docId, { publishedRev: rev });

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

    const docId = documentId();
    if (!docId) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      setRevisions(await api.documentHistory.get(spaceId, docId));
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

    const docId = documentId();
    if (!docId) {
      throw new Error("No document selected");
    }

    try {
      const updatedRevision = await api.documentHistory.patch(spaceId, docId, rev, {
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

    const docId = documentId();
    if (!docId) {
      throw new Error("No document selected");
    }

    try {
      const document = await api.document.get(spaceId, docId, { rev });
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
