/**
 * What goes into a document's search index — the flattened text and its
 * embedding. The rows are read and written by `#db/space/search.ts`.
 */

import type { SpaceStore } from "#db/client/store.ts";
import {
  readDocumentIndexSource,
  readDocumentType,
  readIndexableDocumentIds,
  readStaleIndexDocumentIds,
  writeDocumentIndex,
} from "#db/space/search.ts";
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";
import {
  buildDocumentSearchText,
  embedText,
  serializeEmbedding,
} from "#search/embedding.ts";

const contentIndexedDocumentTypes = new Set(["document", "record"]);

function contentIsIndexed(type: string | null): boolean {
  return type === null || contentIndexedDocumentTypes.has(type);
}

export async function updateDocumentEmbedding(
  s: SpaceStore,
  documentId: string,
): Promise<void> {
  const meta = await readDocumentType(s, documentId);

  if (!meta) {
    return;
  }

  const source = await readDocumentIndexSource(s, documentId, {
    includeContent: contentIsIndexed(meta.type),
  });

  if (!source) {
    return;
  }

  const fileText = source.files
    .map((f) =>
      f.extractedText
        ? `[${f.originalName ?? f.path}]\n${f.extractedText}`
        : `[${f.originalName ?? f.path}]`,
    )
    .join("\n\n");

  const properties = Object.fromEntries(
    source.properties.map((item) => [item.key, item.value]),
  );
  const searchText = buildDocumentSearchText(
    source.content,
    properties,
    fileText || undefined,
  );

  await writeDocumentIndex(s, documentId, {
    searchText,
    searchEmbedding: serializeEmbedding(await embedText(s.platform, searchText)),
    searchEmbeddingModel: s.platform.embedder.model,
    searchUpdatedAt: new Date(),
  });
}

/**
 * Start a search refresh without delaying or failing the document write. It
 * waits for the commit: embedding is external I/O and must not run inside one.
 */
export function scheduleDocumentSearchRefresh(s: SpaceStore, documentId: string): void {
  s.afterCommit((committed) => {
    void updateDocumentEmbedding(committed, documentId).catch((error) => {
      appLogger.warn("Failed to refresh document search", {
        error,
        spaceId: committed.spaceId,
        documentId,
      });
    });
  });
}

export async function rebuildSearchIndex(s: SpaceStore): Promise<void> {
  for (const documentId of await readIndexableDocumentIds(s)) {
    await updateDocumentEmbedding(s, documentId);
  }
}

/**
 * Catch up documents that are unindexed or indexed by an older model. Silent
 * when the embedding runtime is unavailable: search falls back to keywords.
 */
export async function refreshStaleDocumentIndexes(s: SpaceStore): Promise<void> {
  try {
    const staleIds = await readStaleIndexDocumentIds(s, s.platform.embedder.model);
    for (const documentId of staleIds) {
      await updateDocumentEmbedding(s, documentId);
    }
  } catch {
    // Embedding runtime unavailable — skip catch-up indexing.
  }
}
