/**
 * The space's write order, read forwards.
 *
 * A consumer holds one number — the position it has caught up to — and asks for
 * everything above it. Documents come back with the sequence they were last
 * written at; deletions come back as tombstones, because a row that is gone
 * cannot appear in a scan of rows that exist.
 *
 * The feed is gap-free, and not by luck. `nextChangeSeq` is a write, so it takes
 * SQLite's single write lock, and that lock is held until commit — a transaction
 * cannot allocate a sequence above one that is still uncommitted. Sequence order
 * is commit order, so a consumer that has seen `n` has seen everything below it
 * and can advance without looking back. On an engine with concurrent writers
 * this would need a commit-order table instead, and on the in-memory path (see
 * `store.ts`, where a transaction is not a transaction) it does not hold at all.
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
   * The position to resume from. It is the highest sequence *examined*, not the
   * highest returned: a page whose entries were all filtered away still made
   * progress, and a consumer that rewound to the last visible entry would read
   * the same invisible rows forever.
   */
  nextSince: number;
  /** Whether the page filled, and so whether asking again may yield more. */
  hasMore: boolean;
}

export interface ListDocumentChangesOptions {
  since: number;
  limit: number;
  /**
   * Whose reading of the feed this is. Live documents are filtered to what this
   * viewer may read; a null viewer is a trusted system caller. Tombstones are
   * not filtered — the grants that would decide are revoked with the document —
   * so they carry an id and a time and nothing else.
   */
  viewer: AclViewer | null;
}

export async function listDocumentChanges(
  s: SpaceStore,
  options: ListDocumentChangesOptions,
): Promise<DocumentChangesPage> {
  const { since, limit, viewer } = options;

  // One page's worth from each side: the merge below can take at most `limit`
  // in total, so neither side can contribute more than that on its own.
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
            // Workflow runs write on every status change and the document route
            // answers 404 for them, so a consumer offered one could only fail to
            // fetch it. `IS NULL OR !=` because a null type is not `!=` anything
            // in SQL, and most documents have no type at all.
            or(
              isNull(document.type),
              ne(document.type, workflowRunDocumentType),
            ),
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

  // Every sequence in this page is accounted for, including the ones the viewer
  // may not read, so resuming from the last of them skips nothing it was owed.
  const nextSince = page[page.length - 1].changeSeq;
  const hasMore = ordered.length > page.length || page.length === limit;

  // Reading an archived document takes `editor`, which is what listing them
  // takes — so the feed asks the same two questions rather than one weaker one.
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
