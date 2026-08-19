/**
 * The upload index: which document each stored file belongs to.
 *
 * An attachment is not a resource of its own — it is part of the document it
 * was uploaded to, and that document decides who may read it.
 */

import { eq, inArray } from "drizzle-orm";
import { type AclViewer, ResourceType } from "#acl/permissions.ts";
import { filterReadableResources } from "#acl/store.ts";
import { many, one } from "#db/client/query.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { file as fileTable } from "#db/schema/space.ts";
import { getSpace } from "#db/space/spaces.ts";

/** Ceiling on the ids per `IN (...)`, keeping the statement under SQLite's limit. */
const ID_CHUNK = 500;

/**
 * The document an upload is attached to. A standalone upload, a key with no
 * index row, and an unknown space all answer `null` — the first two because
 * only a space-wide role reaches such a file, the last because this runs ahead
 * of the route's guard, which is what owes that caller its refusal. Hence the
 * `spaceId` rather than a store: there may not be a database to open.
 */
export async function getFileDocumentId(
  spaceId: string,
  path: string,
): Promise<string | null> {
  if (!(await getSpace(spaceId))) return null;

  const { db } = await openSpaceStore(spaceId);
  const row = await one(
    db
      .select({ documentId: fileTable.documentId })
      .from(fileTable)
      .where(eq(fileTable.path, path)),
  );
  return row?.documentId ?? null;
}

/** As above for many keys at once. Keys the index does not know are absent. */
export async function getFileDocumentIds(
  spaceId: string,
  paths: string[],
): Promise<Map<string, string | null>> {
  const { db } = await openSpaceStore(spaceId);
  const byPath = new Map<string, string | null>();
  for (let i = 0; i < paths.length; i += ID_CHUNK) {
    const rows = await many(
      db
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
 * it is attached to. A `null` viewer is a trusted system caller.
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
