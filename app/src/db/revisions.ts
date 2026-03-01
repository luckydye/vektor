import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { and, desc, eq } from "drizzle-orm";
import { notFoundResponse } from "../db/api.ts";
import { createAuditLog } from "./auditLogs.ts";
import { getSpaceDb } from "./db.ts";
import { document, revision } from "./schema/space.ts";
import { triggerWebhooks } from "./webhooks.ts";
import { getUniqueMentionedEmails } from "./mentions.ts";
import { invalidateMentionCache } from "./documents.ts";

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
  message?: string,
): Promise<Revision> {
  const db = await getSpaceDb(spaceId);
  const checksum = calculateChecksum(html);

  const lastRevision = await db
    .select()
    .from(revision)
    .where(eq(revision.documentId, documentId))
    .orderBy(desc(revision.rev))
    .limit(1)
    .get();

  if (lastRevision && lastRevision.checksum === checksum) {
    return {
      id: lastRevision.id,
      documentId: lastRevision.documentId,
      rev: lastRevision.rev,
      slug: lastRevision.slug,
      snapshot: lastRevision.snapshot,
      checksum: lastRevision.checksum,
      parentRev: lastRevision.parentRev,
      message: lastRevision.message,
      createdAt: new Date(lastRevision.createdAt),
      createdBy: lastRevision.createdBy,
    };
  }

  const nextRev = lastRevision ? lastRevision.rev + 1 : 1;
  const compressed = compressHtml(html);
  const id = crypto.randomUUID();
  const now = new Date();
  const slug = await getDocumentSlug(spaceId, documentId);

  await db.insert(revision).values({
    id,
    documentId,
    rev: nextRev,
    slug,
    snapshot: compressed,
    checksum,
    parentRev: lastRevision ? lastRevision.rev : null,
    message: message || null,
    createdAt: now,
    createdBy: userId,
  });

  const doc = await db
    .select({ publishedRev: document.publishedRev })
    .from(document)
    .where(eq(document.id, documentId))
    .get();

  const updateFields: { currentRev: number; publishedRev?: number } = {
    currentRev: nextRev,
  };

  if (doc?.publishedRev !== null && doc?.publishedRev !== undefined) {
    updateFields.publishedRev = nextRev;
  }

  await db.update(document).set(updateFields).where(eq(document.id, documentId));

  await createAuditLog(db, {
    docId: documentId,
    revisionId: nextRev,
    userId,
    event: "save",
    details: { message: message || "Revision created" },
  });

  if (updateFields.publishedRev) {
    invalidateMentionCache(documentId);

    await createAuditLog(db, {
      docId: documentId,
      revisionId: nextRev,
      userId,
      event: "publish",
      details: { message: `Auto-published revision ${nextRev}` },
    });

    await triggerWebhooks(db, {
      event: "document.published",
      spaceId,
      documentId,
      revisionId: nextRev,
      timestamp: new Date().toISOString(),
    });

    const mentionedEmails = getUniqueMentionedEmails(html);
    if (mentionedEmails.length > 0) {
      for (const email of mentionedEmails) {
        await triggerWebhooks(db, {
          event: "mention",
          spaceId,
          documentId,
          revisionId: nextRev,
          timestamp: new Date().toISOString(),
          data: {
            mentionedUser: email,
            mentionedBy: userId,
          },
        });
      }
    }
  }

  return {
    id,
    documentId,
    rev: nextRev,
    slug,
    snapshot: compressed,
    checksum,
    parentRev: lastRevision ? lastRevision.rev : null,
    message: message || null,
    createdAt: now,
    createdBy: userId,
  };
}

export async function publishRevision(
  spaceId: string,
  documentId: string,
  rev: number,
): Promise<void> {
  const db = await getSpaceDb(spaceId);

  const revisionRecord = await db
    .select()
    .from(revision)
    .where(and(eq(revision.documentId, documentId), eq(revision.rev, rev)))
    .get();

  if (!revisionRecord) {
    throw new Error("Revision not found");
  }

  const revisionContent = await getRevisionContent(
    spaceId,
    documentId,
    revisionRecord.rev,
  );

  await db
    .update(document)
    .set({ publishedRev: rev, content: revisionContent || "" })
    .where(eq(document.id, documentId));

  invalidateMentionCache(documentId);

  await createAuditLog(db, {
    docId: documentId,
    revisionId: rev,
    userId: undefined,
    event: "publish",
    details: { message: `Published revision ${rev}` },
  });

  await triggerWebhooks(db, {
    event: "document.published",
    spaceId,
    documentId,
    revisionId: rev,
    timestamp: new Date().toISOString(),
  });

  const mentionedEmails = getUniqueMentionedEmails(revisionContent || "");
  if (mentionedEmails.length > 0) {
    for (const email of mentionedEmails) {
      await triggerWebhooks(db, {
        event: "mention",
        spaceId,
        documentId,
        revisionId: rev,
        timestamp: new Date().toISOString(),
        data: {
          mentionedUser: email,
        },
      });
    }
  }
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
    id: revisionRecord.id,
    documentId: revisionRecord.documentId,
    rev: revisionRecord.rev,
    slug: revisionRecord.slug,
    snapshot: revisionRecord.snapshot,
    checksum: revisionRecord.checksum,
    parentRev: revisionRecord.parentRev,
    message: revisionRecord.message,
    createdAt: new Date(revisionRecord.createdAt),
    createdBy: revisionRecord.createdBy,
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

export async function getCurrentContent(
  spaceId: string,
  documentId: string,
): Promise<string | null> {
  const db = await getSpaceDb(spaceId);

  const doc = await db.select().from(document).where(eq(document.id, documentId)).get();

  if (!doc || doc.currentRev === 0) {
    return null;
  }

  return getRevisionContent(spaceId, documentId, doc.currentRev);
}

export async function listRevisions(
  spaceId: string,
  documentId: string,
): Promise<Revision[]> {
  const db = await getSpaceDb(spaceId);

  const revisions = await db
    .select()
    .from(revision)
    .where(eq(revision.documentId, documentId))
    .orderBy(desc(revision.rev))
    .all();

  return revisions.map((r) => ({
    id: r.id,
    documentId: r.documentId,
    rev: r.rev,
    slug: r.slug,
    snapshot: r.snapshot,
    checksum: r.checksum,
    parentRev: r.parentRev,
    message: r.message,
    createdAt: new Date(r.createdAt),
    createdBy: r.createdBy,
  }));
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
    docId: documentId,
    revisionId: rev,
    userId,
    event: "restore",
    details: { message: restoredMessage },
  });

  return createRevision(spaceId, documentId, content, userId, restoredMessage);
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

  return {
    id: revisionRecord.id,
    documentId: revisionRecord.documentId,
    rev: revisionRecord.rev,
    slug: revisionRecord.slug,
    checksum: revisionRecord.checksum,
    parentRev: revisionRecord.parentRev,
    message: revisionRecord.message,
    createdAt: new Date(revisionRecord.createdAt),
    createdBy: revisionRecord.createdBy,
  };
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
      message: revision.message,
      createdAt: revision.createdAt,
      createdBy: revision.createdBy,
    })
    .from(revision)
    .where(eq(revision.documentId, documentId))
    .orderBy(desc(revision.rev))
    .all();

  return revisions.map((r) => ({
    id: r.id,
    documentId: r.documentId,
    rev: r.rev,
    slug: r.slug,
    checksum: r.checksum,
    parentRev: r.parentRev,
    message: r.message,
    createdAt: new Date(r.createdAt),
    createdBy: r.createdBy,
  }));
}
