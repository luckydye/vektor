/**
 * The space's write order, read forwards: a consumer holds one number and asks
 * for everything above it.
 *
 * The feed is gap-free because `nextChangeSeq` is a write, so it holds SQLite's
 * single write lock until commit and no transaction can allocate a sequence
 * above one still uncommitted — sequence order is commit order. That is a
 * property of this engine, and it does not hold on the in-memory path where
 * `store.ts` runs transactions as plain calls.
 */

import { and, asc, gt, isNull, ne, or } from "drizzle-orm";
import { type AclViewer, Permission, ResourceType } from "#acl/permissions.ts";
import { filterReadableResources } from "#acl/store.ts";
import { many } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { document, documentTombstone } from "#db/schema/space.ts";
import { workflowRunDocumentType } from "#documents/types.ts";
import { type DocumentMeta, getDocumentsByIds } from "./documents.ts";

export type DocumentChange =
  | { changeSeq: number; documentId: string; deleted: false; document: DocumentMeta }
  | { changeSeq: number; documentId: string; deleted: true; deletedAt: Date };

export interface DocumentChangesPage {
  changes: DocumentChange[];
  /**
   * The position to resume from: the highest sequence examined, not the highest
   * returned, so a page filtered down to nothing still makes progress.
   */
  nextSince: number;
  hasMore: boolean;
}

export interface ListDocumentChangesOptions {
  since: number;
  limit: number;
  /**
   * Live documents are filtered to what this viewer may read; null is a trusted
   * system caller. Tombstones are not filtered — the grants that would decide
   * were revoked with the document — so they carry an id and a time, no more.
   */
  viewer: AclViewer | null;
}

export async function listDocumentChanges(
  s: SpaceStore,
  options: ListDocumentChangesOptions,
): Promise<DocumentChangesPage> {
  const { since, limit, viewer } = options;

  // One page from each side: the merge takes at most `limit` in total, so
  // neither side can contribute more than that alone.
  const [written, deleted] = await Promise.all([
    many(
      s.db
        .select({
          id: document.id,
          changeSeq: document.changeSeq,
          archived: document.archived,
        })
        .from(document)
        .where(
          and(
            gt(document.changeSeq, since),
            // Runs write on every status change and the document route 404s
            // them. `IS NULL OR !=` because most documents have no type, and a
            // null is not `!=` anything in SQL.
            or(isNull(document.type), ne(document.type, workflowRunDocumentType)),
          ),
        )
        .orderBy(asc(document.changeSeq))
        .limit(limit),
    ),
    many(
      s.db
        .select({
          documentId: documentTombstone.documentId,
          changeSeq: documentTombstone.changeSeq,
          deletedAt: documentTombstone.deletedAt,
        })
        .from(documentTombstone)
        .where(gt(documentTombstone.changeSeq, since))
        .orderBy(asc(documentTombstone.changeSeq))
        .limit(limit),
    ),
  ]);

  const ordered = [
    ...written.map((row) => ({
      changeSeq: row.changeSeq,
      id: row.id,
      archived: row.archived,
      tombstone: null as Date | null,
    })),
    ...deleted.map((row) => ({
      changeSeq: row.changeSeq,
      id: row.documentId,
      archived: false,
      tombstone: row.deletedAt,
    })),
  ].sort((a, b) => a.changeSeq - b.changeSeq);

  const page = ordered.slice(0, limit);
  if (page.length === 0) {
    return { changes: [], nextSince: since, hasMore: false };
  }

  // Includes the entries the viewer may not read, so resuming here skips
  // nothing it was owed.
  const nextSince = page[page.length - 1].changeSeq;
  const hasMore = ordered.length > page.length || page.length === limit;

  const live = page.filter((entry) => !entry.tombstone);
  const visibleIds = viewer
    ? await readableDocumentIds(s, live, viewer)
    : live.map((entry) => entry.id);
  const metadata = await getDocumentsByIds(s, visibleIds);

  const changes: DocumentChange[] = [];
  for (const entry of page) {
    if (entry.tombstone) {
      changes.push({
        changeSeq: entry.changeSeq,
        documentId: entry.id,
        deleted: true,
        deletedAt: entry.tombstone,
      });
      continue;
    }
    const meta = metadata.get(entry.id);
    if (!meta) continue;
    changes.push({
      changeSeq: entry.changeSeq,
      documentId: entry.id,
      deleted: false,
      document: meta,
    });
  }

  return { changes, nextSince, hasMore };
}

/** Archived documents take `editor` to read, as they do to list. */
async function readableDocumentIds(
  s: SpaceStore,
  entries: { id: string; archived: boolean }[],
  viewer: AclViewer,
): Promise<string[]> {
  const byPermission = [
    { ids: entries.filter((e) => !e.archived).map((e) => e.id), role: Permission.VIEWER },
    { ids: entries.filter((e) => e.archived).map((e) => e.id), role: Permission.EDITOR },
  ];

  const readable = await Promise.all(
    byPermission.map(({ ids, role }) =>
      ids.length === 0
        ? new Set<string>()
        : filterReadableResources(s.spaceId, ResourceType.DOCUMENT, ids, viewer, role),
    ),
  );

  return entries.map((e) => e.id).filter((id) => readable.some((set) => set.has(id)));
}
