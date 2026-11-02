import type { SpaceStore } from "#db/client/store.ts";
import { deletePrefix } from "#files/storage.ts";
import { appLogger } from "#observability/logger.ts";
import { isCanvasBaseKey } from "./canvasBase.ts";
import { readCanvasSnapshot } from "./canvasSnapshot.ts";

/** Content over this many UTF-8 bytes lives in the blob store, and the row's `content` is empty. */
const INLINE_CONTENT_BYTES = 1024 * 1024;

/** A document's content, with the blob key `storeDocumentContent` spilled it under, if any. */
export interface StoredDocumentContent {
  documentId: string;
  content: string;
  contentKey: string | null;
}

/** The row's `content` and `content_key` columns for `stored`. */
export function contentColumns(stored: StoredDocumentContent): {
  content: string;
  contentKey: string | null;
} {
  return {
    content: stored.contentKey === null ? stored.content : "",
    contentKey: stored.contentKey,
  };
}

function documentContentPrefix(documentId: string): string {
  return `documents/${documentId}/`;
}

/**
 * Spill `content` to the blob store when it is too large to inline. Each spill takes a
 * fresh key, so the row write that points at it is the commit point.
 */
export async function storeDocumentContent(
  s: SpaceStore,
  documentId: string,
  content: string,
): Promise<StoredDocumentContent> {
  if (Buffer.byteLength(content, "utf-8") <= INLINE_CONTENT_BYTES) {
    return { documentId, content, contentKey: null };
  }
  const contentKey = `${documentContentPrefix(documentId)}${crypto.randomUUID()}`;
  await s.platform.blobStore.put(s.spaceId, contentKey, Buffer.from(content, "utf-8"));
  return { documentId, content, contentKey };
}

export async function readDocumentContent(
  s: SpaceStore,
  row: { content: string; contentKey: string | null },
): Promise<string> {
  if (row.contentKey === null) return row.content;
  // A canvas lives in the object store; whole-document readers get its snapshot JSON.
  if (isCanvasBaseKey(row.contentKey)) {
    const documentId = row.contentKey.split("/")[1];
    return JSON.stringify(await readCanvasSnapshot(s, documentId));
  }
  const stored = await s.platform.blobStore.read(s.spaceId, row.contentKey);
  if (!stored)
    throw new Error(`Document content ${row.contentKey} is missing from storage`);
  return stored.toString("utf-8");
}

/**
 * Remove a spilled content blob no row points at any more. A canvas base is
 * left to the canvas GC, which keeps it while a revision names it.
 */
export function deleteSpilledContent(s: SpaceStore, contentKey: string): Promise<void> {
  if (isCanvasBaseKey(contentKey)) return Promise.resolve();
  return s.platform.blobStore.delete(s.spaceId, contentKey).catch((error) => {
    appLogger.warn("Failed to delete spilled document content", {
      error,
      spaceId: s.spaceId,
      contentKey,
    });
  });
}

/** Remove every spilled content blob of a document whose row is gone, including ones a failed write left behind. */
export async function deleteDocumentContents(
  s: SpaceStore,
  documentId: string,
): Promise<void> {
  await deletePrefix(s.platform.blobStore, s.spaceId, documentContentPrefix(documentId));
}
