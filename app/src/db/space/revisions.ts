import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  brotliCompress,
  brotliDecompressSync,
  constants as zlibConstants,
} from "node:zlib";
import { and, desc, eq } from "drizzle-orm";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { document, revision } from "#db/schema/space.ts";
import { appLogger } from "#observability/logger.ts";
import { createAuditLog } from "./auditLogs.ts";

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

const brotliCompressAsync = promisify(brotliCompress);

// Brotli's default quality (11) costs seconds of CPU on large canvases (tens of
// MB). The synchronous zlib API ran that inline on Bun's single event-loop
// thread, stalling every connected client for the duration of a save. Run the
// compression on libuv's threadpool instead, and drop the quality for large
// payloads so effort scales sub-linearly with document size.
const LARGE_PAYLOAD_BYTES = 512 * 1024;

async function compressHtml(html: string): Promise<Buffer> {
  const buffer = Buffer.from(html, "utf-8");
  const quality = buffer.byteLength > LARGE_PAYLOAD_BYTES ? 4 : 11;
  return await brotliCompressAsync(buffer, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: quality,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buffer.byteLength,
    },
  });
}

export function decompressHtml(compressed: Buffer): string {
  try {
    const decompressed = brotliDecompressSync(compressed);
    return decompressed.toString("utf-8");
  } catch (error) {
    appLogger.error("Failed to decompress HTML", { error });
    throw new Error("Failed to decompress revision content");
  }
}

function calculateChecksum(html: string): string {
  return createHash("sha256").update(html, "utf-8").digest("hex");
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

export async function createRevision(
  s: SpaceStore,
  documentId: string,
  html: string,
  userId: string,
  options: CreateRevisionOptions = {},
): Promise<Revision> {
  const checksum = calculateChecksum(html);
  const status = options.status ?? null;

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

  const OVERWRITE_WINDOW_MS = 3 * 60 * 60 * 1000;
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
  if (
    lastIsRecent &&
    !lastIsPublished &&
    status === null &&
    (lastRevision?.status ?? null) === null
  ) {
    const compressed = await compressHtml(html);
    const updatedMessage = options.message ?? lastRevision?.message;
    await s.db
      .update(revision)
      .set({ snapshot: compressed, checksum, message: updatedMessage })
      .where(eq(revision.id, lastRevision?.id));

    await createAuditLog(s, {
      spaceId: s.spaceId,
      docId: documentId,
      revisionId: lastRevision?.rev,
      userId,
      event: "save",
      details: { message: options.message || "Revision updated" },
    });

    return {
      id: lastRevision?.id,
      documentId: lastRevision?.documentId,
      rev: lastRevision?.rev,
      slug: lastRevision?.slug,
      snapshot: compressed,
      checksum,
      parentRev: lastRevision?.parentRev,
      status: null,
      message: updatedMessage,
      createdAt: new Date(lastRevision?.createdAt),
      createdBy: lastRevision?.createdBy,
    };
  }

  const nextRev = lastRevision ? lastRevision.rev + 1 : 1;
  const compressed = await compressHtml(html);
  const id = createId("revision");
  const now = new Date();
  const slug = await getDocumentSlug(s, documentId);

  await s.db.insert(revision).values({
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
    await s.db
      .update(document)
      .set({ currentRev: nextRev })
      .where(eq(document.id, documentId));
  }

  await createAuditLog(s, {
    spaceId: s.spaceId,
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
  try {
    return decompressHtml(revisionRecord.snapshot);
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

export async function getPublishedContent(
  s: SpaceStore,
  documentId: string,
): Promise<string | null> {
  const storedDocument = await one(
    s.db
      .select({ publishedRev: document.publishedRev })
      .from(document)
      .where(eq(document.id, documentId)),
  );

  if (!storedDocument || storedDocument.publishedRev === null) return null;
  return getRevisionContent(s, documentId, storedDocument.publishedRev);
}

export async function restoreRevision(
  s: SpaceStore,
  documentId: string,
  rev: number,
  userId: string,
  message?: string,
): Promise<Revision | null> {
  const content = await getRevisionContent(s, documentId, rev);
  if (!content) {
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

  return createRevision(s, documentId, content, userId, {
    message: restoredMessage,
  });
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
        status: revision.status,
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

export async function updateRevisionStatus(
  s: SpaceStore,
  documentId: string,
  rev: number,
  status: NonNullable<Revision["status"]>,
): Promise<Omit<Revision, "snapshot"> | null> {
  await s.db
    .update(revision)
    .set({ status })
    .where(and(eq(revision.documentId, documentId), eq(revision.rev, rev)));

  return getRevisionMetadata(s, documentId, rev);
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
        status: revision.status,
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

export async function createSuggestion(
  s: SpaceStore,
  documentId: string,
  html: string,
  userId: string,
  message?: string,
): Promise<Revision> {
  const doc = await one(
    s.db
      .select({ publishedRev: document.publishedRev })
      .from(document)
      .where(eq(document.id, documentId)),
  );

  if (!doc) {
    throw new Error(`Document ${documentId} not found`);
  }

  const parentRev = doc.publishedRev;
  if (!parentRev) {
    throw new Error("Cannot create suggestion without a published revision");
  }

  return createRevision(s, documentId, html, userId, {
    message,
    status: "open",
    parentRev,
  });
}
