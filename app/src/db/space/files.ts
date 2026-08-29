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
import { uploadKeyFromUrl } from "#files/uploads.ts";

/** Ceiling on the ids per `IN (...)`, keeping the statement under SQLite's limit. */
const ID_CHUNK = 500;

/**
 * What the index knows about a stored file, beyond the bytes on disk.
 *
 * A key alone says nothing a person recognises: it is a content hash. The name
 * the file was uploaded under, and the document it belongs to, live only here.
 */
export interface FileIndexEntry {
  documentId: string | null;
  originalName: string | null;
  mimeType: string | null;
}

/**
 * What the index holds for one upload. A key with no index row and an unknown
 * space both answer `null` — the first because only a space-wide role reaches
 * such a file, the second because this runs ahead of the route's guard, which
 * is what owes that caller its refusal. Hence the `spaceId` rather than a
 * store: there may not be a database to open.
 */
export async function getFileIndexEntry(
  spaceId: string,
  path: string,
): Promise<FileIndexEntry | null> {
  if (!(await getSpace(spaceId))) return null;

  const { db } = await openSpaceStore(spaceId);
  const row = await one(
    db
      .select({
        documentId: fileTable.documentId,
        originalName: fileTable.originalName,
        mimeType: fileTable.mimeType,
      })
      .from(fileTable)
      .where(eq(fileTable.path, path)),
  );
  if (!row) return null;
  return {
    documentId: row.documentId ?? null,
    originalName: row.originalName ?? null,
    mimeType: row.mimeType ?? null,
  };
}

/**
 * Index entries for many keys at once. Keys the index does not know are absent
 * from the map rather than present and empty, so a caller can tell "no row" from
 * "a row that records nothing".
 */
export async function getFileIndexEntries(
  spaceId: string,
  paths: string[],
): Promise<Map<string, FileIndexEntry>> {
  const { db } = await openSpaceStore(spaceId);
  const byPath = new Map<string, FileIndexEntry>();
  for (let i = 0; i < paths.length; i += ID_CHUNK) {
    const rows = await many(
      db
        .select({
          path: fileTable.path,
          documentId: fileTable.documentId,
          originalName: fileTable.originalName,
          mimeType: fileTable.mimeType,
        })
        .from(fileTable)
        .where(inArray(fileTable.path, paths.slice(i, i + ID_CHUNK))),
    );
    for (const row of rows) {
      byPath.set(row.path, {
        documentId: row.documentId ?? null,
        originalName: row.originalName ?? null,
        mimeType: row.mimeType ?? null,
      });
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

/**
 * An uploaded image's stored pixel dimensions, or null when they are unknown.
 *
 * Read from the `file` row rather than from the image: the columns are written
 * once at upload, and `syncFileIndex` fills them for rows that predate them. A
 * row that is still missing them — a non-image, or one not yet reconciled —
 * answers null, and the caller renders without an intrinsic ratio exactly as it
 * did before the file was indexed.
 *
 * Takes a `spaceId` rather than a store for the same reason as
 * {@link getFileIndexEntry}: callers reach this before any database is open.
 */
export async function getUploadImageDimensions(
  spaceId: string,
  url: string | string[] | undefined,
): Promise<{ width: number; height: number } | null> {
  const key = uploadKeyFromUrl(spaceId, Array.isArray(url) ? url[0] : url);
  if (!key) return null;
  if (!(await getSpace(spaceId))) return null;

  const { db } = await openSpaceStore(spaceId);
  const row = await one(
    db
      .select({ width: fileTable.width, height: fileTable.height })
      .from(fileTable)
      .where(eq(fileTable.path, key)),
  );

  if (!row?.width || !row.height) return null;
  return { width: row.width, height: row.height };
}

/** Width/height ratio of an uploaded image, or null when it is not known. */
export async function getUploadImageAspectRatio(
  spaceId: string,
  url: string | string[] | undefined,
): Promise<number | null> {
  const dimensions = await getUploadImageDimensions(spaceId, url);
  if (!dimensions || dimensions.height <= 0) return null;
  return dimensions.width / dimensions.height;
}
