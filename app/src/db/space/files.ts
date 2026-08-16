/**
 * The upload index: which document each stored file belongs to.
 *
 * An attachment is not a resource of its own — it is part of the document it
 * was uploaded to, and that document decides who may read it. Every gate on an
 * upload key therefore starts by resolving its parent here.
 */

import { eq, inArray } from "drizzle-orm";
import { type AclViewer, ResourceType } from "#acl/permissions.ts";
import { filterReadableResources } from "#acl/store.ts";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { file as fileTable } from "#db/schema/space.ts";

/** Ceiling on the ids per `IN (...)`, keeping the statement under SQLite's limit. */
const ID_CHUNK = 500;

/**
 * The document an upload is attached to, or `null` for a standalone upload.
 *
 * A key with no index row resolves to `null` as well, which is the same answer
 * as far as access goes: it belongs to no document, so only a space-wide role
 * reaches it.
 */
export async function getFileDocumentId(
  s: SpaceStore,
  path: string,
): Promise<string | null> {
  const row = await one(
    s.db
      .select({ documentId: fileTable.documentId })
      .from(fileTable)
      .where(eq(fileTable.path, path)),
  );
  return row?.documentId ?? null;
}

/**
 * The parent document of each of `paths`, in one pass. Keys the index does not
 * know about are absent from the map; read them as `null` (see above).
 */
export async function getFileDocumentIds(
  s: SpaceStore,
  paths: string[],
): Promise<Map<string, string | null>> {
  const byPath = new Map<string, string | null>();
  for (let i = 0; i < paths.length; i += ID_CHUNK) {
    const rows = await many(
      s.db
        .select({ path: fileTable.path, documentId: fileTable.documentId })
        .from(fileTable)
        .where(inArray(fileTable.path, paths.slice(i, i + ID_CHUNK))),
    );
    for (const row of rows) {
      byPath.set(row.path, row.documentId ?? null);
    }
  }
  return byPath;
}

/**
 * Keep only the files `viewer` may read, each authorized through the document
 * it is attached to. A `null` viewer is a trusted system caller and sees all of
 * them.
 */
export async function filterAccessibleFiles<T extends { documentId: string | null }>(
  spaceId: string,
  files: T[],
  viewer: AclViewer | null,
): Promise<T[]> {
  if (!viewer) return files;

  const parentIds = [
    ...new Set(
      files
        .map((file) => file.documentId)
        .filter((documentId): documentId is string => documentId !== null),
    ),
  ];
  const readableParentIds = await filterReadableResources(
    spaceId,
    ResourceType.DOCUMENT,
    parentIds,
    viewer,
  );

  return files.filter((file) =>
    file.documentId === null
      ? // A file attached to no document is a space-wide upload, readable by
        // anyone in the space but not reachable through any one grant.
        !viewer.documentScope
      : readableParentIds.has(file.documentId),
  );
}
