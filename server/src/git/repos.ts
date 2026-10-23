/**
 * Repositories as the product sees them: documents.
 *
 * A repository is a document of type `repository`, so it is created, renamed,
 * moved, archived and deleted through the endpoints that already do those
 * things. Nothing here duplicates them — this only resolves one to the prefix
 * holding its git objects, and cleans that prefix up when the document goes.
 */

import type { SpaceStore } from "#db/client/store.ts";
import { getDocumentBySlug } from "#db/space/documents.ts";
import { repositoryDocumentType } from "#documents/types.ts";
import { type BlobStore, deletePrefix } from "#files/storage.ts";
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";
import { repoPrefix } from "./state.ts";

export interface RepositoryDocument {
  id: string;
  slug: string;
  /** Pushes are refused to an archived or locked repository. */
  writable: boolean;
  defaultBranch: string;
}

/**
 * The repository a clone URL names, or null when the slug is not one.
 *
 * Slugs are unique within a space, so this is the same single lookup a document
 * URL already does — no index of repositories to keep beside it.
 */
export async function resolveRepository(
  store: SpaceStore,
  slug: string,
): Promise<RepositoryDocument | null> {
  const doc = await getDocumentBySlug(store, slug);
  if (!doc || doc.type !== repositoryDocumentType) return null;

  return {
    id: doc.id,
    slug: doc.slug,
    writable: !doc.archived && !doc.readonly,
    // Every repository starts on `main`; the branch a client pushed first is
    // what HEAD follows afterwards, recorded in the stored state.
    defaultBranch: "main",
  };
}

/**
 * Delete every object a repository owns.
 *
 * Called when its document is deleted. Through the storage adapter rather than
 * by dropping the host's local copy: that is a cache, and dropping only it
 * would leave the objects in the bucket with nothing failing to say so.
 */
export async function deleteRepositoryObjects(
  platform: Platform,
  storage: BlobStore,
  spaceId: string,
  documentId: string,
): Promise<number> {
  const removed = await deletePrefix(storage, spaceId, `${repoPrefix(documentId)}/`);

  await platform.git?.forget(spaceId, documentId);
  if (removed > 0) {
    appLogger.info("Deleted repository objects", { spaceId, documentId, removed });
  }
  return removed;
}
