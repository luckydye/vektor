import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { and, desc, eq } from "drizzle-orm";
import { notFoundResponse } from "#db/api.ts";
import { createAuditLog } from "./auditLogs.ts";
import { getSpaceDb } from "./db.ts";
import { createId } from "./ids.ts";
import { document, revision } from "./schema/space.ts";

export interface Revision {
  id: string;
  documentId: string;
  rev: number;
  slug: string;
  snapshot: Buffer;
  checksum: string;
  parentRev: number | null;
  status: "open" | "applied" | "dismissed" | null;
  message: string | null;
  createdAt: Date;
  createdBy: string;
}

export interface CreateRevisionOptions {
  message?: string;
  status?: Revision["status"];
  parentRev?: number | null;
}

function compressHtml(html: string): Buffer {
  const buffer = Buffer.from(html, "utf-8");
  return brotliCompressSync(buffer);
}

export function decompressHtml(compressed: Buffer): string {
  try {
    const decompressed = brotliDecompressSync(compressed);
    return decompressed.toString("utf-8");
  } catch (error) {
    console.error("Failed to decompress HTML:", error);
    throw new Error("Failed to decompress revision content");
  }
}

function calculateChecksum(html: string): string {
  return createHash("sha256").update(html, "utf-8").digest("hex");
}

async function getDocumentSlug(spaceId: string, documentId: string): Promise<string> {
  const db = await getSpaceDb(spaceId);

  const doc = await db
    .select({ slug: document.slug })
    .from(document)
    .where(eq(document.id, documentId))
    .get();

  if (!doc) {
    throw new Error(`Document ${documentId} not found`);
  }

  return doc.slug;
}

export async function createRevision(
  spaceId: string,
  documentId: string,
  html: string,
  userId: string,
  options: CreateRevisionOptions = {},
): Promise<Revision> {
  const db = await getSpaceDb(spaceId);
  const checksum = calculateChecksum(html);
  const status = options.status ?? null;

  const lastRevision = await db
    .select()
    .from(revision)
    .where(eq(revision.documentId, documentId))
    .orderBy(desc(revision.rev))
    .limit(1)
    .get();

  // Identical content — return existing revision as-is.
  if (
    lastRevision &&
    lastRevision.checksum === checksum &&
    (lastRevision.status ?? null) === status &&
    (lastRevision.parentRev ?? null) === (options.parentRev ?? null)
  ) {
    return {
      id: lastRevision.id,
      documentId: lastRevision.documentId,
      rev: lastRevision.rev,
      slug: lastRevision.slug,
      snapshot: lastRevision.snapshot,
      checksum: lastRevision.checksum,
      parentRev: lastRevision.parentRev,
      status: (lastRevision.status as Revision["status"] | null) ?? null,
      message: lastRevision.message,
      createdAt: new Date(lastRevision.createdAt),
      createdBy: lastRevision.createdBy,
    };
  }

  const OVERWRITE_WINDOW_MS = 5 * 60 * 60 * 1000;
  const lastIsRecent =
    lastRevision &&
    Date.now() - new Date(lastRevision.createdAt).getTime() < OVERWRITE_WINDOW_MS;

  const doc = await db
    .select({ publishedRev: document.publishedRev })
    .from(document)
    .where(eq(document.id, documentId))
    .get();
  const lastIsPublished = lastRevision && lastRevision.rev === doc?.publishedRev;

  // Overwrite the last revision in place if it's a regular save within the 5-hour window,
  // but never overwrite the published revision — that would silently change published content.
  if (
    lastIsRecent &&
    !lastIsPublished &&
    status === null &&
    (lastRevision!.status ?? null) === null
  ) {
    const compressed = compressHtml(html);
    const updatedMessage = options.message ?? lastRevision!.message;
    await db
      .update(revision)
      .set({ snapshot: compressed, checksum, message: updatedMessage })
      .where(eq(revision.id, lastRevision!.id));

    await createAuditLog(db, {
      spaceId,
      docId: documentId,
      revisionId: lastRevision!.rev,
      userId,
      event: "save",
      details: { message: options.message || "Revision updated" },
    });

    return {
      id: lastRevision!.id,
      documentId: lastRevision!.documentId,
      rev: lastRevision!.rev,
      slug: lastRevision!.slug,
      snapshot: compressed,
      checksum,
      parentRev: lastRevision!.parentRev,
      status: null,
      message: updatedMessage,
      createdAt: new Date(lastRevision!.createdAt),
      createdBy: lastRevision!.createdBy,
    };
  }

  const nextRev = lastRevision ? lastRevision.rev + 1 : 1;
  const compressed = compressHtml(html);
  const id = createId("revision");
  const now = new Date();
  const slug = await getDocumentSlug(spaceId, documentId);

  await db.insert(revision).values({
    id,
    documentId,
    rev: nextRev,
    slug,
    snapshot: compressed,
    checksum,
    parentRev: options.parentRev ?? (lastRevision ? lastRevision.rev : null),
    status,
    message: options.message || null,
    createdAt: now,
    createdBy: userId,
  });

  if (status === null) {
    await db
      .update(document)
      .set({ currentRev: nextRev })
      .where(eq(document.id, documentId));
  }

  await createAuditLog(db, {
    spaceId,
    docId: documentId,
    revisionId: nextRev,
    userId,
    event: status !== null ? "suggest" : "save",
    details: {
      message:
        options.message || (status !== null ? "Suggestion created" : "Revision created"),
      parentRev: options.parentRev ?? (lastRevision ? lastRevision.rev : null),
      status,
    },
  });

  return {
    id,
    documentId,
    rev: nextRev,
    slug,
    snapshot: compressed,
    checksum,
    parentRev: options.parentRev ?? (lastRevision ? lastRevision.rev : null),
    status,
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
    status: (r.status as Revision["status"] | null) ?? null,
    message: r.message,
    createdAt: new Date(r.createdAt),
    createdBy: r.createdBy,
  };
}

export async function getRevision(
  spaceId: string,
  documentId: string,
  rev: number,
): Promise<Revision | null> {
  const db = await getSpaceDb(spaceId);

  const revisionRecord = await db
    .select()
    .from(revision)
    .where(and(eq(revision.documentId, documentId), eq(revision.rev, rev)))
    .get();

  if (!revisionRecord) {
    return null;
  }

  return {
    ...rowToRevisionMetadata(revisionRecord),
    snapshot: revisionRecord.snapshot,
  };
}

export async function getRevisionContent(
  spaceId: string,
  documentId: string,
  rev: number,
): Promise<string | null> {
  const revisionRecord = await getRevision(spaceId, documentId, rev);
  if (!revisionRecord) {
    return null;
  }
  try {
    return decompressHtml(revisionRecord.snapshot);
  } catch (error) {
    console.error(
      `Failed to decompress revision ${rev} for document ${documentId}:`,
      error,
    );
    return null;
  }
}

export async function getPublishedContent(
  spaceId: string,
  documentId: string,
): Promise<string | null> {
  const db = await getSpaceDb(spaceId);

  const doc = await db.select().from(document).where(eq(document.id, documentId)).get();

  if (!doc || doc.publishedRev === null) {
    return null;
  }

  return getRevisionContent(spaceId, documentId, doc.publishedRev);
}

export async function restoreRevision(
  spaceId: string,
  documentId: string,
  rev: number,
  userId: string,
  message?: string,
): Promise<Revision> {
  const content = await getRevisionContent(spaceId, documentId, rev);
  if (!content) {
    throw notFoundResponse("Revision");
  }

  const restoredMessage = message || `Restored from revision ${rev}`;

  await createAuditLog(await getSpaceDb(spaceId), {
    spaceId,
    docId: documentId,
    revisionId: rev,
    userId,
    event: "restore",
    details: { message: restoredMessage },
  });

  return createRevision(spaceId, documentId, content, userId, {
    message: restoredMessage,
  });
}

export async function getRevisionMetadata(
  spaceId: string,
  documentId: string,
  rev: number,
): Promise<Omit<Revision, "snapshot"> | null> {
  const db = await getSpaceDb(spaceId);

  const revisionRecord = await db
    .select({
      id: revision.id,
      documentId: revision.documentId,
      rev: revision.rev,
      slug: revision.slug,
      checksum: revision.checksum,
      parentRev: revision.parentRev,
      status: revision.status,
      message: revision.message,
      createdAt: revision.createdAt,
      createdBy: revision.createdBy,
    })
    .from(revision)
    .where(and(eq(revision.documentId, documentId), eq(revision.rev, rev)))
    .get();

  if (!revisionRecord) {
    return null;
  }

  return rowToRevisionMetadata(revisionRecord);
}

export async function updateRevisionStatus(
  spaceId: string,
  documentId: string,
  rev: number,
  status: NonNullable<Revision["status"]>,
): Promise<Omit<Revision, "snapshot"> | null> {
  const db = await getSpaceDb(spaceId);

  await db
    .update(revision)
    .set({ status })
    .where(and(eq(revision.documentId, documentId), eq(revision.rev, rev)));

  return getRevisionMetadata(spaceId, documentId, rev);
}

export async function listRevisionMetadata(
  spaceId: string,
  documentId: string,
): Promise<Omit<Revision, "snapshot">[]> {
  const db = await getSpaceDb(spaceId);

  const revisions = await db
    .select({
      id: revision.id,
      documentId: revision.documentId,
      rev: revision.rev,
      slug: revision.slug,
      checksum: revision.checksum,
      parentRev: revision.parentRev,
      status: revision.status,
      message: revision.message,
      createdAt: revision.createdAt,
      createdBy: revision.createdBy,
    })
    .from(revision)
    .where(eq(revision.documentId, documentId))
    .orderBy(desc(revision.rev))
    .all();

  return revisions.map(rowToRevisionMetadata);
}

export async function createSuggestion(
  spaceId: string,
  documentId: string,
  html: string,
  userId: string,
  message?: string,
): Promise<Revision> {
  const db = await getSpaceDb(spaceId);
  const doc = await db
    .select({ publishedRev: document.publishedRev })
    .from(document)
    .where(eq(document.id, documentId))
    .get();

  if (!doc) {
    throw notFoundResponse("Document");
  }

  const parentRev = doc.publishedRev;
  if (!parentRev) {
    throw new Error("Cannot create suggestion without a published revision");
  }

  return createRevision(spaceId, documentId, html, userId, {
    message,
    status: "open",
    parentRev,
  });
}
