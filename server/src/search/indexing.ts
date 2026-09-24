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
import {
  buildDocumentSearchText,
  embedText,
  serializeEmbedding,
} from "#search/embedding.ts";
import { getEmbeddingModel } from "#search/embeddingRuntime.ts";

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
    searchEmbedding: serializeEmbedding(await embedText(searchText)),
    searchEmbeddingModel: getEmbeddingModel(),
    searchUpdatedAt: new Date(),
  });
}

/** Start a search refresh without delaying or failing the document write. */
export function scheduleDocumentSearchRefresh(s: SpaceStore, documentId: string): void {
  void updateDocumentEmbedding(s, documentId).catch((error) => {
    appLogger.warn("Failed to refresh document search", {
      error,
      spaceId: s.spaceId,
      documentId,
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
    const staleIds = await readStaleIndexDocumentIds(s, getEmbeddingModel());
    for (const documentId of staleIds) {
      await updateDocumentEmbedding(s, documentId);
    }
  } catch {
    // Embedding runtime unavailable — skip catch-up indexing.
  }
}
