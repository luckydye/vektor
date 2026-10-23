import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  brotliCompress,
  brotliDecompressSync,
  constants as zlibConstants,
} from "node:zlib";
import { and, desc, eq, sql } from "drizzle-orm";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { document, revision } from "#db/schema/space.ts";
import { deletePrefix } from "#files/storage.ts";
import { appLogger } from "#observability/logger.ts";
import { createAuditLog } from "./auditLogs.ts";
import { touchDocument } from "./changeSeq.ts";

export interface Revision {
  id: string;
  documentId: string;
  rev: number;
  slug: string;
  snapshot: Buffer;
  checksum: string;
  parentRev: number | null;
  message: string | null;
  createdAt: Date;
  createdBy: string;
}

export type RevisionKind = "save" | "checkpoint" | "restore";

export interface CreateRevisionOptions {
  message?: string;
  parentRev?: number | null;
  kind?: RevisionKind;
}

function coalescesWithPrevious(kind: RevisionKind): boolean {
  return kind === "save" || kind === "checkpoint";
}

const brotliCompressAsync = promisify(brotliCompress);

// Brotli's default quality (11) costs seconds of CPU on large canvases (tens of
// MB). The synchronous zlib API ran that inline on Bun's single event-loop
// thread, stalling every connected client for the duration of a save. Run the
// compression on libuv's threadpool instead, and drop the quality for large
// payloads so effort scales sub-linearly with document size.
const LARGE_PAYLOAD_BYTES = 512 * 1024;

async function compressRevisionContent(content: string): Promise<Buffer> {
  const buffer = Buffer.from(content, "utf-8");
  const quality = buffer.byteLength > LARGE_PAYLOAD_BYTES ? 4 : 11;
  return await brotliCompressAsync(buffer, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: quality,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buffer.byteLength,
    },
  });
}

function decompressRevisionContent(compressed: Buffer): string {
  try {
    const decompressed = brotliDecompressSync(compressed);
    return decompressed.toString("utf-8");
  } catch (error) {
    appLogger.error("Failed to decompress revision content", { error });
    throw new Error("Failed to decompress revision content");
  }
}

/** A compressed snapshot over this size lives in the blob store, and the row's `snapshot` is empty. */
const INLINE_SNAPSHOT_BYTES = 1024 * 1024;

function revisionSnapshotPrefix(documentId: string): string {
  return `revisions/${documentId}/`;
}

/** Keyed by revision id, which an overwrite replaces, so a key is written once and never reused. */
function revisionSnapshotKey(documentId: string, revisionId: string): string {
  return `${revisionSnapshotPrefix(documentId)}${revisionId}`;
}

/** The row's `snapshot` for `compressed`, which is spilled to the blob store first when too large to inline. */
async function storeSnapshot(
  s: SpaceStore,
  documentId: string,
  revisionId: string,
  compressed: Buffer,
): Promise<Buffer> {
  if (compressed.byteLength <= INLINE_SNAPSHOT_BYTES) return compressed;
  await s.platform.blobStore.put(
    s.spaceId,
    revisionSnapshotKey(documentId, revisionId),
    compressed,
  );
  return Buffer.alloc(0);
}

/** Run the row write that makes a spilled snapshot reachable, removing the blob again when it fails. */
async function commitSnapshot<T>(
  s: SpaceStore,
  documentId: string,
  revisionId: string,
  snapshot: Buffer,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (snapshot.byteLength === 0) {
      await s.platform.blobStore.delete(
        s.spaceId,
        revisionSnapshotKey(documentId, revisionId),
      );
    }
    throw error;
  }
}

async function readSnapshot(
  s: SpaceStore,
  row: { id: string; documentId: string; snapshot: Buffer },
): Promise<Buffer> {
  if (row.snapshot.byteLength > 0) return row.snapshot;
  const stored = await s.platform.blobStore.read(
    s.spaceId,
    revisionSnapshotKey(row.documentId, row.id),
  );
  if (!stored) throw new Error(`Snapshot of revision ${row.id} is missing from storage`);
  return stored;
}

/** Remove the spilled snapshots of a document whose rows are gone. */
export async function deleteRevisionSnapshots(
  s: SpaceStore,
  documentId: string,
): Promise<void> {
  await deletePrefix(s.platform.blobStore, s.spaceId, revisionSnapshotPrefix(documentId));
}

function calculateChecksum(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

async function getDocumentSlug(s: SpaceStore, documentId: string): Promise<string> {
  const doc = await one(
    s.db
      .select({ slug: document.slug })
      .from(document)
      .where(eq(document.id, documentId)),
  );

  if (!doc) {
    throw new Error(`Document ${documentId} not found`);
  }

  return doc.slug;
}

/** Returns when the most recent revision was created without loading its snapshot. */
export async function getLatestRevisionCreatedAt(
  s: SpaceStore,
  documentId: string,
): Promise<Date | null> {
  const latestRevision = await one(
    s.db
      .select({ createdAt: revision.createdAt })
      .from(revision)
      .where(eq(revision.documentId, documentId))
      .orderBy(desc(revision.rev))
      .limit(1),
  );

  return latestRevision?.createdAt ?? null;
}

const OVERWRITE_WINDOW_MS = 3 * 60 * 60 * 1000;

interface RevisionRow {
  id: string;
  documentId: string;
  slug: string;
  snapshot: Buffer;
  checksum: string;
  /** Null follows the document's highest revision, whichever that is on insert. */
  parentRev: number | null;
  message: string | null;
  createdAt: Date;
  createdBy: string;
}

/**
 * Insert a revision whose number the insert itself allocates.
 *
 * `max(rev) + 1` computed in JavaScript let concurrent saves claim one number,
 * so all but one was lost and `currentRev`/`publishedRev` addressed several rows
 * at once. As one statement the read and the write share SQLite's write lock,
 * and `revision_document_id_rev_unique` rejects anything that says otherwise.
 */
async function insertRevision(
  s: SpaceStore,
  row: RevisionRow,
): Promise<{ rev: number; parentRev: number | null }> {
  const highestRev = sql`(select max(${revision.rev}) from ${revision} where ${revision.documentId} = ${row.documentId})`;

  const inserted = await many(
    s.db
      .insert(revision)
      .values({
        ...row,
        rev: sql`coalesce(${highestRev}, 0) + 1`,
        parentRev: row.parentRev ?? highestRev,
      })
      .returning({ rev: revision.rev, parentRev: revision.parentRev }),
  );

  if (!inserted[0]) {
    throw new Error(`Failed to create revision for document ${row.documentId}`);
  }
  return inserted[0];
}

export async function createRevision(
  s: SpaceStore,
  documentId: string,
  content: string,
  userId: string,
  options: CreateRevisionOptions = {},
): Promise<Revision> {
  const checksum = calculateChecksum(content);
  const kind = options.kind ?? "save";
  const parentRev = options.parentRev ?? null;

  const lastRevision = await one(
    s.db
      .select()
      .from(revision)
      .where(eq(revision.documentId, documentId))
      .orderBy(desc(revision.rev))
      .limit(1),
  );

  // Identical content — return existing revision as-is.
  if (
    lastRevision &&
    lastRevision.checksum === checksum &&
    (lastRevision.parentRev ?? null) === parentRev
  ) {
    return { ...rowToRevisionMetadata(lastRevision), snapshot: lastRevision.snapshot };
  }

  const lastIsRecent =
    lastRevision &&
    Date.now() - new Date(lastRevision.createdAt).getTime() < OVERWRITE_WINDOW_MS;

  const doc = await one(
    s.db
      .select({ publishedRev: document.publishedRev })
      .from(document)
      .where(eq(document.id, documentId)),
  );
  const lastIsPublished = lastRevision && lastRevision.rev === doc?.publishedRev;

  // Overwrite the last revision in place if it's a regular save within the 3-hour window,
  // but never overwrite the published revision — that would silently change published content.
  if (lastRevision && lastIsRecent && !lastIsPublished && coalescesWithPrevious(kind)) {
    const compressed = await compressRevisionContent(content);
    const updatedMessage = options.message ?? lastRevision.message;
    // The overwrite takes a fresh id, so the new snapshot lands under its own key
    // and the row swap below is the single point where it replaces the old one.
    const id = createId("revision");
    const snapshot = await storeSnapshot(s, documentId, id, compressed);
    const replaced = await commitSnapshot(s, documentId, id, snapshot, () =>
      s.tx(async (tx) => {
        // Re-read inside the transaction: a concurrent overwrite may have swapped the id already.
        const current = await one(
          tx.db
            .select({
              id: revision.id,
              inlineBytes: sql<number>`length(${revision.snapshot})`,
            })
            .from(revision)
            .where(
              and(
                eq(revision.documentId, documentId),
                eq(revision.rev, lastRevision.rev),
              ),
            ),
        );
        if (!current) {
          throw new Error(
            `Revision ${lastRevision.rev} of document ${documentId} is gone`,
          );
        }
        await tx.db
          .update(revision)
          .set({ id, snapshot, checksum, message: updatedMessage })
          .where(eq(revision.id, current.id));
        return current;
      }),
    );
    if (replaced.inlineBytes === 0) {
      await s.platform.blobStore
        .delete(s.spaceId, revisionSnapshotKey(documentId, replaced.id))
        .catch((error) => {
          appLogger.warn("Failed to delete replaced revision snapshot", {
            error,
            spaceId: s.spaceId,
            documentId,
          });
        });
    }

    await createAuditLog(s, {
      spaceId: s.spaceId,
      docId: documentId,
      revisionId: lastRevision.rev,
      userId,
      event: "save",
      details: { message: options.message || "Revision updated" },
    });

    return {
      ...rowToRevisionMetadata(lastRevision),
      id,
      snapshot,
      checksum,
      message: updatedMessage,
    };
  }

  const compressed = await compressRevisionContent(content);
  const id = createId("revision");
  const now = new Date();
  const slug = await getDocumentSlug(s, documentId);
  const snapshot = await storeSnapshot(s, documentId, id, compressed);

  const created = await commitSnapshot(s, documentId, id, snapshot, () =>
    insertRevision(s, {
      id,
      documentId,
      slug,
      snapshot,
      checksum,
      parentRev,
      message: options.message || null,
      createdAt: now,
      createdBy: userId,
    }),
  );

  // Never backwards: a save that landed while this one compressed has already
  // moved the pointer past the revision written here.
  //
  // Unconditional: the caller asked for a revision of the content it supplied.
  await touchDocument(s, documentId, {
    currentRev: sql`max(${document.currentRev}, ${created.rev})`,
  });

  await createAuditLog(s, {
    spaceId: s.spaceId,
    docId: documentId,
    revisionId: created.rev,
    userId,
    event: "save",
    details: {
      message: options.message || "Revision created",
      parentRev: created.parentRev,
    },
  });

  return {
    id,
    documentId,
    rev: created.rev,
    slug,
    snapshot,
    checksum,
    parentRev: created.parentRev,
    message: options.message || null,
    createdAt: now,
    createdBy: userId,
  };
}

function rowToRevisionMetadata(
  r: Omit<typeof revision.$inferSelect, "snapshot">,
): Omit<Revision, "snapshot"> {
  return {
    id: r.id,
    documentId: r.documentId,
    rev: r.rev,
    slug: r.slug,
    checksum: r.checksum,
    parentRev: r.parentRev,
    message: r.message,
    createdAt: new Date(r.createdAt),
    createdBy: r.createdBy,
  };
}

export async function getRevision(
  s: SpaceStore,
  documentId: string,
  rev: number,
): Promise<Revision | null> {
  const revisionRecord = await one(
    s.db
      .select()
      .from(revision)
      .where(and(eq(revision.documentId, documentId), eq(revision.rev, rev))),
  );

  if (!revisionRecord) {
    return null;
  }

  return {
    ...rowToRevisionMetadata(revisionRecord),
    snapshot: revisionRecord.snapshot,
  };
}

export async function getRevisionContent(
  s: SpaceStore,
  documentId: string,
  rev: number,
): Promise<string | null> {
  const revisionRecord = await getRevision(s, documentId, rev);
  if (!revisionRecord) {
    return null;
  }
  const snapshot = await readSnapshot(s, revisionRecord);
  try {
    return decompressRevisionContent(snapshot);
  } catch (error) {
    appLogger.error(`Failed to decompress revision ${rev} for document ${documentId}`, {
      error,
    });
    return null;
  }
}

export async function resolvePublishedDocumentContent<
  T extends {
    id: string;
    content?: string;
    publishedRev: number | null;
  },
>(s: SpaceStore, document: T): Promise<T> {
  if (document.publishedRev === null) return document;

  const content = await getRevisionContent(s, document.id, document.publishedRev);
  return content === null ? document : { ...document, content };
}

export async function restoreRevision(
  s: SpaceStore,
  documentId: string,
  rev: number,
  userId: string,
  message?: string,
): Promise<{ revision: Revision; content: string } | null> {
  const content = await getRevisionContent(s, documentId, rev);
  if (content === null) {
    return null;
  }

  const restoredMessage = message || `Restored from revision ${rev}`;

  await createAuditLog(s, {
    spaceId: s.spaceId,
    docId: documentId,
    revisionId: rev,
    userId,
    event: "restore",
    details: { message: restoredMessage },
  });

  const revision = await createRevision(s, documentId, content, userId, {
    message: restoredMessage,
    kind: "restore",
  });
  return { revision, content };
}

export async function getRevisionMetadata(
  s: SpaceStore,
  documentId: string,
  rev: number,
): Promise<Omit<Revision, "snapshot"> | null> {
  const revisionRecord = await one(
    s.db
      .select({
        id: revision.id,
        documentId: revision.documentId,
        rev: revision.rev,
        slug: revision.slug,
        checksum: revision.checksum,
        parentRev: revision.parentRev,
        message: revision.message,
        createdAt: revision.createdAt,
        createdBy: revision.createdBy,
      })
      .from(revision)
      .where(and(eq(revision.documentId, documentId), eq(revision.rev, rev))),
  );

  if (!revisionRecord) {
    return null;
  }

  return rowToRevisionMetadata(revisionRecord);
}

export async function listRevisionMetadata(
  s: SpaceStore,
  documentId: string,
): Promise<Omit<Revision, "snapshot">[]> {
  const revisions = await many(
    s.db
      .select({
        id: revision.id,
        documentId: revision.documentId,
        rev: revision.rev,
        slug: revision.slug,
        checksum: revision.checksum,
        parentRev: revision.parentRev,
        message: revision.message,
        createdAt: revision.createdAt,
        createdBy: revision.createdBy,
      })
      .from(revision)
      .where(eq(revision.documentId, documentId))
      .orderBy(desc(revision.rev)),
  );

  return revisions.map(rowToRevisionMetadata);
}
