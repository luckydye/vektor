import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `DocumentPageView` reuses its subtree across navigation: when the next
 * document is already cached, `doc()` never goes undefined, so the children —
 * `HeaderImage`, `DocumentProperties` — are not recreated and only their props
 * change. A composable that read its id once at setup kept serving the previous
 * document, which is how a header image survived a navigation away from it.
 */

const documents: Record<string, { id: string; properties: Record<string, string> }> = {
  doc_a: { id: "doc_a", properties: { title: "A" } },
  doc_b: { id: "doc_b", properties: { title: "B", headerImage: "/b.png" } },
};

const revisionCalls: string[] = [];

vi.mock("@solidjs/router", () => ({ useNavigate: () => () => {} }));

vi.mock("#api/client.ts", () => ({
  api: {
    spaces: {
      get: async () => [{ id: "space_1", name: "First", slug: "first" }],
      getCached: async () => undefined,
      subscribeCached: () => () => {},
    },
    document: {
      get: async (_spaceId: string, documentId: string) => documents[documentId],
      getCached: async () => undefined,
      subscribeCached: () => () => {},
      post: async (_spaceId: string, documentId: string) => {
        revisionCalls.push(documentId);
        return { rev: 1 };
      },
    },
    documentHistory: { get: async () => [] },
    subscribeToTopics: () => () => {},
  },
}));

const { QueryClient, setFallbackQueryClient } = await import("#composeables/query.ts");
const { useDocument } = await import("#composeables/useDocument.ts");
const { useRevisions } = await import("#composeables/useRevisions.ts");

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  revisionCalls.length = 0;
});

function inRoot<T>(setup: () => T): T {
  setFallbackQueryClient(new QueryClient());
  let value!: T;
  createRoot((dispose) => {
    disposers.push(dispose);
    value = setup();
  });
  return value;
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("document composables follow the id they are given", () => {
  it("useDocument re-reads when the id changes under a live caller", async () => {
    const [documentId, setDocumentId] = createSignal<string | undefined>("doc_a");
    const { document } = inRoot(() => useDocument(documentId));
    await settle();
    expect(document()?.id).toBe("doc_a");

    setDocumentId("doc_b");
    await settle();
    expect(document()?.properties.headerImage).toBe("/b.png");

    // Back to a document the cache already holds — the case that used to keep
    // showing `doc_b`.
    setDocumentId("doc_a");
    await settle();
    expect(document()?.id).toBe("doc_a");
    expect(document()?.properties.headerImage).toBeUndefined();
  });

  it("useRevisions writes to the current document, not the one it was created with", async () => {
    const [documentId, setDocumentId] = createSignal<string | undefined>("doc_a");
    const { saveRevision } = inRoot(() => useRevisions(documentId));
    await settle();

    setDocumentId("doc_b");
    await saveRevision("<p>hi</p>");

    expect(revisionCalls).toEqual(["doc_b"]);
  });
});
