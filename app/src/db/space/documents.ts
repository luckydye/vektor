import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { type AclViewer, Permission, ResourceType } from "#acl/permissions.ts";
import { filterReadableResources, revokePermission } from "#acl/store.ts";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { decodeSeekCursor, encodeSeekCursor } from "#db/cursor.ts";
import { createId } from "#db/ids.ts";
import {
  comment,
  document,
  file as fileTable,
  property,
  revision,
} from "#db/schema/space.ts";
import { extractMentionsFromHtml } from "#documents/mentions.ts";
import {
  assertWritableDocumentPropertyKey,
  canonicalPropertyKey,
  type DocumentProperties,
  type DocumentPropertyValue,
  parseStoredPropertyValue,
  propertyValueToScalar,
  propertyValueToText,
  serializePropertyValue,
  storedPropertyKey,
  toDocumentProperties,
  toDocumentPropertiesByDocument,
} from "#documents/properties.ts";
import {
  allowsChildDocumentType,
  documentIsReadonly,
  fallbackDocumentSlug,
  isSerializedDocumentType,
  repositoryDocumentType,
} from "#documents/types.ts";
import { extractFileTextFromBuffer } from "#files/extractText.ts";
import {
  DIMENSION_READABLE_EXTENSIONS,
  readImageDimensions,
} from "#files/imageDimensions.ts";
import { getFileStorage, listAllFiles } from "#files/storage.ts";
import { deleteRepositoryObjects } from "#git/repos.ts";
import { appLogger } from "#observability/logger.ts";
import { scheduleDocumentSearchRefresh } from "#search/indexing.ts";
import { isReservedDocumentSlug, slugify } from "#utils/slug.ts";
import { createAuditLog } from "./auditLogs.ts";
import {
  deleteDocumentRow,
  type DocumentWriteOutcome,
  type DocumentWriteResult,
  nextChangeSeq,
  touchDocument,
} from "./changeSeq.ts";
import { deleteDocumentEmailPreferences } from "./emailNotificationPreferences.ts";
import { filterAccessibleFiles } from "./files.ts";
import { decompressRevisionContent } from "./revisions.ts";
import { fileRowToDocument, nonArchivedDocumentCondition } from "./search.ts";

export interface DocumentWithProperties {
  id: string;
  slug: string;
  type?: string | null;
  content?: string;
  currentRev: number;
  publishedRev: number | null;
  changeSeq: number;
  properties: DocumentProperties;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  parentId: string | null;
  readonly: boolean;
  archived: boolean;
  mentionCount?: number;
  locked?: boolean;
  /** Set for file-table entries — use this URL instead of the doc route */
  fileUrl?: string;
  /** Set for file-table entries: the stored size in bytes, where it is known */
  fileSize?: number;
}

const archivedDocumentCondition = sql`
  (
    ${document.archived} = 1
    OR ${document.archived} = '1'
    OR ${document.archived} = '1.0'
    OR ${document.archived} = TRUE
  )
`;

export async function generateUniqueSlug(
  s: SpaceStore,
  baseTitle: string,
  excludeDocumentId?: string,
): Promise<string> {
  // A title in a script with no ASCII fold is ordinary user input, so it gets a
  // generated slug rather than a refusal — replaceable by the first title the
  // URL can carry, see `isPlaceholderDocumentSlug`.
  const baseSlug = slugify(baseTitle) || fallbackDocumentSlug(createId("document"));

  const allDocs = await many(
    s.db.select({ id: document.id, slug: document.slug }).from(document),
  );

  const existingSlugs = new Set(
    allDocs.filter((d) => d.id !== excludeDocumentId).map((d) => d.slug),
  );
  const isTaken = (candidate: string) =>
    existingSlugs.has(candidate) || isReservedDocumentSlug(candidate);

  if (!isTaken(baseSlug)) {
    return baseSlug;
  }

  let counter = 1;
  let slug = `${baseSlug}-${counter}`;

  while (isTaken(slug)) {
    counter++;
    slug = `${baseSlug}-${counter}`;
  }

  return slug;
}

export type PropertyInit =
  | string
  | string[]
  | number
  | boolean
  | { value: unknown; type?: string | null };

export class InvalidDocumentParentError extends Error {}

export interface CreateDocumentOptions {
  properties?: Record<string, PropertyInit>;
  parentId?: string | null;
  type?: string;
  readonly?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Enforce the generic parent document's child-type policy before creating or
 * reparenting a document.
 */
export async function assertDocumentCanParent(
  s: SpaceStore,
  parentId: string,
  childType: string | null | undefined,
): Promise<void> {
  const parent = await one(
    s.db.select({ type: document.type }).from(document).where(eq(document.id, parentId)),
  );
  if (!parent) throw new InvalidDocumentParentError("Parent document not found");
  if (!allowsChildDocumentType(parent.type, childType)) {
    throw new InvalidDocumentParentError(
      "This document cannot contain documents of this type",
    );
  }
}

export async function createDocument(
  s: SpaceStore,
  createdBy: string,
  slug: string,
  content: string,
  options: CreateDocumentOptions = {},
): Promise<DocumentWithProperties> {
  const { properties: initialProperties, parentId, type, readonly = false } = options;
  if (parentId) await assertDocumentCanParent(s, parentId, type);
  // Every key up front, before the document row exists: the property inserts
  // below are not in one transaction with it, so rejecting halfway would leave a
  // document behind that the caller was told was never created.
  for (const key of Object.keys(initialProperties ?? {})) {
    assertWritableDocumentPropertyKey(storedPropertyKey(key));
  }
  const id = createId("document");
  const now = new Date();
  const documentCreatedAt = options.createdAt || now;
  const documentUpdatedAt = options.updatedAt || now;

  // Generate a unique slug if the provided slug already exists
  const uniqueSlug = await generateUniqueSlug(s, slug);

  const changeSeq = await s.tx(async (tx) => {
    const allocated = await nextChangeSeq(tx);
    await tx.db.insert(document).values({
      id,
      slug: uniqueSlug,
      type: type || null,
      content,
      currentRev: 0,
      publishedRev: null,
      changeSeq: allocated,
      createdBy: createdBy,
      parentId: parentId || null,
      archived: false,
      readonly,
      createdAt: documentCreatedAt,
      updatedAt: documentUpdatedAt,
    });
    return allocated;
  });

  const properties = initialProperties || {};
  // A `Map`, materialised once below: the reserved-key guard above already keeps
  // `__proto__` out, but bracket-assigning a user-supplied key into an object
  // literal is the shape of the bug this whole file just stopped repeating.
  const storedProperties = new Map<string, DocumentPropertyValue>();

  const initialEntries = new Map(
    Object.entries(properties).map(([key, raw]) => [
      canonicalPropertyKey(key),
      [storedPropertyKey(key), raw] as const,
    ]),
  );

  for (const [key, raw] of initialEntries.values()) {
    const isWrappedValue =
      typeof raw === "object" && raw !== null && !Array.isArray(raw) && "value" in raw;
    const propValue = isWrappedValue ? raw.value : raw;
    const propType = isWrappedValue ? (raw.type ?? null) : null;
    const storedValue = serializePropertyValue(propValue);
    storedProperties.set(key, parseStoredPropertyValue(storedValue));
    await s.db.insert(property).values({
      id: createId("property"),
      documentId: id,
      key,
      value: storedValue,
      type: propType,
      createdAt: now,
      updatedAt: now,
    });
  }

  scheduleDocumentSearchRefresh(s, id);

  await createAuditLog(s, {
    spaceId: s.spaceId,
    docId: id,
    userId: createdBy,
    event: "create",
    details: { message: "Document created" },
  });

  return {
    id,
    slug: uniqueSlug,
    type: type || null,
    content,
    currentRev: 0,
    publishedRev: null,
    changeSeq,
    properties: Object.fromEntries(storedProperties),
    createdAt: documentCreatedAt,
    updatedAt: documentUpdatedAt,
    createdBy: createdBy,
    parentId: parentId || null,
    readonly,
    archived: false,
  };
}

/** Document fields excluding the (potentially very large) `content` column. */
export type DocumentMeta = Omit<DocumentWithProperties, "content">;

/**
 * Loads a document's metadata WITHOUT its `content` column. `content` can be
 * tens of MB (large canvases), so the default read is metadata-only; callers
 * that actually need the body call `getDocumentContent` separately. This keeps
 * the hot paths (auth, save bookkeeping, listings) from pulling the whole
 * column into memory.
 */
export async function getDocument(
  s: SpaceStore,
  id: string,
): Promise<DocumentMeta | null> {
  const doc = await one(
    s.db
      .select({
        id: document.id,
        slug: document.slug,
        type: document.type,
        currentRev: document.currentRev,
        publishedRev: document.publishedRev,
        changeSeq: document.changeSeq,
        parentId: document.parentId,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        createdBy: document.createdBy,
        readonly: document.readonly,
        archived: document.archived,
      })
      .from(document)
      .where(eq(document.id, id)),
  );

  if (!doc) {
    return null;
  }

  const props = await many(
    s.db.select().from(property).where(eq(property.documentId, id)),
  );
  const properties = toDocumentProperties(props);

  return { ...doc, parentId: doc.parentId || null, properties };
}

/** The document carrying this property key and value, if one does. */
export async function findDocumentByProperty(
  s: SpaceStore,
  key: string,
  value: string,
): Promise<DocumentMeta | null> {
  const row = await one(
    s.db
      .select({ documentId: property.documentId })
      .from(property)
      .where(and(eq(property.key, key), eq(property.value, value))),
  );
  return row ? getDocument(s, row.documentId) : null;
}

/**
 * `getDocument` for many ids: two queries instead of two per document.
 *
 * For callers that resolve a list of references — a page of workflow runs, an
 * activity log — where the metadata is wanted and the bodies are not.
 */
export async function getDocumentsByIds(
  s: SpaceStore,
  ids: string[],
): Promise<Map<string, DocumentMeta>> {
  const byId = new Map<string, DocumentMeta>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return byId;
  const [docs, props] = await Promise.all([
    many(
      s.db
        .select({
          id: document.id,
          slug: document.slug,
          type: document.type,
          currentRev: document.currentRev,
          publishedRev: document.publishedRev,
          changeSeq: document.changeSeq,
          parentId: document.parentId,
          createdAt: document.createdAt,
          updatedAt: document.updatedAt,
          createdBy: document.createdBy,
          readonly: document.readonly,
          archived: document.archived,
        })
        .from(document)
        .where(inArray(document.id, unique)),
    ),
    many(s.db.select().from(property).where(inArray(property.documentId, unique))),
  ]);

  const propertiesByDocument = toDocumentPropertiesByDocument(props);

  for (const doc of docs) {
    byId.set(doc.id, {
      ...doc,
      parentId: doc.parentId || null,
      properties: propertiesByDocument.get(doc.id) ?? {},
    });
  }

  return byId;
}

/**
 * Loads only a document's `content` column. Pair with `getDocument` when both
 * metadata and body are needed.
 */
export async function getDocumentContent(
  s: SpaceStore,
  id: string,
): Promise<string | null> {
  const row = await one(
    s.db.select({ content: document.content }).from(document).where(eq(document.id, id)),
  );
  return row?.content ?? null;
}

/**
 * What an auth check needs about a document: that it exists, and whether it is
 * archived (which raises the role required to reach it). Null when there is no
 * such document. Selects no content — getDocument here pulled the entire
 * `content` column (tens of MB for large canvases) into memory on every request,
 * which saturated the server under presence/collaboration traffic. `archived`
 * reuses the listings' condition, so a legacy `'1'`/`'1.0'` row counts as one.
 */
export async function getDocumentAuthState(
  s: SpaceStore,
  id: string,
): Promise<{ archived: boolean } | null> {
  const row = await one(
    s.db
      .select({
        id: document.id,
        archived: sql<number>`CASE WHEN ${archivedDocumentCondition} THEN 1 ELSE 0 END`,
      })
      .from(document)
      .where(eq(document.id, id)),
  );
  return row ? { archived: Number(row.archived) === 1 } : null;
}

/** Checks the readonly verdict without loading document content or properties. */
export async function documentIsReadonlyById(
  s: SpaceStore,
  id: string,
): Promise<boolean> {
  const row = await one(
    s.db
      .select({ readonly: document.readonly })
      .from(document)
      .where(eq(document.id, id)),
  );
  return row ? documentIsReadonly(row) : true;
}

export async function getDocumentBySlug(
  s: SpaceStore,
  slug: string,
): Promise<DocumentWithProperties | null> {
  const doc = await one(s.db.select().from(document).where(eq(document.slug, slug)));

  if (!doc) {
    return null;
  }

  const props = await many(
    s.db.select().from(property).where(eq(property.documentId, doc.id)),
  );

  const properties = toDocumentProperties(props);

  return {
    id: doc.id,
    slug: doc.slug,
    type: doc.type,
    content: doc.content,
    currentRev: doc.currentRev,
    publishedRev: doc.publishedRev,
    changeSeq: doc.changeSeq,
    properties,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    createdBy: doc.createdBy,
    parentId: doc.parentId || null,
    readonly: doc.readonly,
    archived: doc.archived,
  };
}

export async function updateDocument(
  s: SpaceStore,
  id: string,
  content: string,
  type?: string | null,
  expected?: number[],
): Promise<DocumentWriteOutcome<DocumentWithProperties>> {
  // getDocument is metadata-only — `existing.content` is never read here (the
  // write uses the new `content`), so we avoid loading the old content (tens of
  // MB on large canvases) every save. It supplies the fields echoed back, never
  // the decision to write.
  const existing = await getDocument(s, id);
  if (!existing) {
    return { ok: false, reason: "missing" };
  }

  const now = new Date();
  const nextType = type === undefined ? existing.type : type;

  const written = await touchDocument(
    s,
    id,
    { content, updatedAt: now, type: nextType },
    expected,
  );
  if (!written.ok) {
    return { ok: false, reason: "conflict" };
  }

  scheduleDocumentSearchRefresh(s, id);

  return {
    ok: true,
    document: {
      id,
      slug: existing.slug,
      content,
      currentRev: existing.currentRev,
      publishedRev: existing.publishedRev,
      changeSeq: written.changeSeq,
      properties: existing.properties,
      createdAt: existing.createdAt,
      updatedAt: now,
      createdBy: existing.createdBy,
      parentId: existing.parentId,
      readonly: existing.readonly,
      type: nextType,
      archived: existing.archived,
    },
  };
}

/**
 * Drop every ACL grant that names this document. Archiving does NOT do this — it
 * raises the role required to reach the document instead, so a restore brings the
 * shares back with it. Only a permanent delete purges the rows.
 */
async function revokeDocumentGrants(
  s: SpaceStore,
  id: string,
  actorUserId?: string,
): Promise<void> {
  await revokePermission(s, ResourceType.DOCUMENT, id, {}, actorUserId);
  await revokePermission(s, ResourceType.DOCUMENT_TREE, id, {}, actorUserId);
}

export async function archiveDocument(
  s: SpaceStore,
  id: string,
  userId?: string,
  expected?: number[],
): Promise<DocumentWriteResult> {
  return s.tx(async (tx) => {
    const written = await touchDocument(
      tx,
      id,
      { archived: true, updatedAt: new Date() },
      expected,
    );
    if (written.ok && userId) {
      await createAuditLog(tx, {
        spaceId: tx.spaceId,
        docId: id,
        userId,
        event: "archive",
        details: { message: "Document archived" },
      });
    }
    return written;
  });
}

/**
 * Clearing `archived` is all a restore has to do: the grants were never revoked,
 * only outranked while the document sat in the trash, so the shares come back.
 */
export async function restoreDocument(
  s: SpaceStore,
  id: string,
  userId?: string,
  expected?: number[],
): Promise<DocumentWriteResult> {
  return s.tx(async (tx) => {
    const written = await touchDocument(
      tx,
      id,
      { archived: false, updatedAt: new Date() },
      expected,
    );
    if (written.ok && userId) {
      await createAuditLog(tx, {
        spaceId: tx.spaceId,
        docId: id,
        userId,
        event: "restore",
        details: { message: "Document restored" },
      });
    }
    return written;
  });
}

export async function deleteDocument(
  s: SpaceStore,
  id: string,
  userId?: string,
  expected?: number[],
): Promise<boolean> {
  // Read before the row goes: afterwards nothing says this document was a
  // repository, and its objects would stay in storage forever.
  const existing = await one(
    s.db.select({ type: document.type }).from(document).where(eq(document.id, id)),
  );
  const wasRepository = existing?.type === repositoryDocumentType;

  const storedFiles = await s.tx(async (tx) => {
    // Read before the delete: `file.document_id` cascades and
    // `document.parent_id` nulls out, so afterwards neither is recoverable.
    const files = await many(
      tx.db
        .select({ path: fileTable.path })
        .from(fileTable)
        .where(eq(fileTable.documentId, id)),
    );
    const children = await many(
      tx.db.select({ id: document.id }).from(document).where(eq(document.parentId, id)),
    );

    if (!(await deleteDocumentRow(tx, id, expected))) return null;

    // `parent_id` was just nulled by the cascade.
    for (const child of children) {
      await touchDocument(tx, child.id, { updatedAt: new Date() });
    }

    if (userId) {
      await createAuditLog(tx, {
        spaceId: tx.spaceId,
        docId: id,
        userId,
        event: "delete",
        details: { message: "Document deleted" },
      });
    }

    // These relationships are encoded rather than relational, so an FK cannot
    // clean them up. Relational child rows cascade from the document delete.
    await deleteDocumentEmailPreferences(tx, id);
    await revokeDocumentGrants(tx, id, userId);
    await tx.db
      .delete(comment)
      .where(and(eq(comment.resourceType, "document"), eq(comment.resourceId, id)));

    return files;
  });

  if (storedFiles === null) return false;

  const storage = getFileStorage();
  if (wasRepository) {
    await deleteRepositoryObjects(storage, s.spaceId, id).catch((error) => {
      appLogger.warn("Failed to delete repository objects", {
        error,
        spaceId: s.spaceId,
        documentId: id,
      });
    });
  }
  for (const { path } of storedFiles) {
    try {
      await storage.delete(s.spaceId, path);
    } catch (error) {
      appLogger.warn("Failed to delete document file from storage", {
        error,
        spaceId: s.spaceId,
        documentId: id,
        path,
      });
    }
  }

  return true;
}

async function syncFileIndex(s: SpaceStore): Promise<void> {
  const storage = getFileStorage();
  const diskFiles = await listAllFiles(storage, s.spaceId);
  if (diskFiles.length === 0) return;

  const indexed = new Map(
    (
      await many(
        s.db
          .select({ path: fileTable.path, size: fileTable.size, width: fileTable.width })
          .from(fileTable),
      )
    ).map((r) => [r.path, r] as const),
  );

  const toIndex = diskFiles.filter((f) => !indexed.has(f.key)).slice(0, 200);

  // Rows indexed before the column existed, filled from the listing just read.
  // Capped like the insert below, so a large space converges over a few calls.
  const toSize = diskFiles.filter((f) => indexed.get(f.key)?.size === null).slice(0, 200);
  for (const { key, size } of toSize) {
    await s.db.update(fileTable).set({ size }).where(eq(fileTable.path, key));
  }

  // The same catch-up for `width`/`height`. Capped far below the rest because
  // this runs inside a file listing and, unlike `size`, the values are not in
  // the listing already — each one costs a read. The rows it fills already
  // render, just without an intrinsic ratio, so this is the one pass here that
  // is pure catch-up and it yields the request rather than converging fast.
  // Restricted to the formats the header parser handles, so an unreadable file
  // is skipped rather than re-fetched on every listing.
  const DIMENSION_BACKFILL_PER_CALL = 25;
  const toDimension = diskFiles
    .filter((f) => {
      const row = indexed.get(f.key);
      if (!row || row.width !== null) return false;
      return DIMENSION_READABLE_EXTENSIONS.has(
        f.key.split(".").pop()?.toLowerCase() ?? "",
      );
    })
    .slice(0, DIMENSION_BACKFILL_PER_CALL);
  for (const { key } of toDimension) {
    const buf = await storage.read(s.spaceId, key);
    const dimensions = buf && readImageDimensions(buf);
    if (!dimensions) continue;
    await s.db
      .update(fileTable)
      .set({ width: dimensions.width, height: dimensions.height })
      .where(eq(fileTable.path, key));
  }

  for (const { key, size, updatedAt } of toIndex) {
    const buf = await storage.read(s.spaceId, key);
    if (!buf) continue;
    const name = key.split("/").pop() ?? key;
    const extracted = extractFileTextFromBuffer(buf, name, undefined);
    const dimensions = readImageDimensions(buf);
    const url = storage.url(s.spaceId, key);
    await s.db
      .insert(fileTable)
      .values({
        path: key,
        documentId: null,
        originalName: name,
        mimeType: null,
        size,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
        url,
        updatedAt,
        extractedText: extracted,
      })
      .onConflictDoNothing();
  }
}

// Cursor encodes the (updatedAt, id) position of the last returned document.
export function encodeListCursor(updatedAt: Date, id: string): string {
  return encodeSeekCursor(updatedAt.getTime(), id);
}

export function decodeListCursor(cursor: string): { updatedAt: Date; id: string } | null {
  const pos = decodeSeekCursor(cursor, "string");
  if (!pos) return null;
  return { updatedAt: new Date(pos.t), id: pos.id as string };
}

export async function listDocuments(
  s: SpaceStore,
  options: {
    limit?: number;
    type?: string;
    /** Required: pass null only where the caller has already authorised. */
    viewer: AclViewer | null;
    cursor?: string;
    /**
     * Append the space's uploaded files, as pseudo-documents, to the first
     * page. Opt-in: the file index is unpaginated — it ships in full whatever
     * `limit` says — and producing it scans the upload directory. Listings that
     * only want documents must not pay for either.
     */
    includeFiles?: boolean;
  },
): Promise<{
  documents: DocumentWithProperties[];
  total: number;
  nextCursor: string | null;
}> {
  const { limit, type, viewer, cursor, includeFiles = false } = options;
  const baseCondition = type
    ? and(nonArchivedDocumentCondition, eq(document.type, type))
    : nonArchivedDocumentCondition;

  const selectFields = {
    id: document.id,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    parentId: document.parentId,
    publishedRev: document.publishedRev,
    slug: document.slug,
    type: document.type,
    currentRev: document.currentRev,
    changeSeq: document.changeSeq,
    createdBy: document.createdBy,
    readonly: document.readonly,
    archived: document.archived,
  };

  type DocRow =
    typeof selectFields extends Record<string, infer _>
      ? {
          id: string;
          createdAt: Date;
          updatedAt: Date;
          parentId: string | null;
          publishedRev: number | null;
          slug: string;
          type: string | null;
          currentRev: number;
          changeSeq: number;
          createdBy: string;
          readonly: boolean;
          archived: boolean;
        }
      : never;

  let docs: DocRow[];
  let total = 0;
  let nextCursor: string | null = null;

  if (viewer) {
    // ACL filtering requires fetching all docs before paginating.
    const allDocs = await many(
      s.db
        .select(selectFields)
        .from(document)
        .where(baseCondition)
        .orderBy(desc(document.updatedAt), desc(document.id)),
    );
    const readable = await filterReadableResources(
      s.spaceId,
      ResourceType.DOCUMENT,
      allDocs.map((d) => d.id),
      viewer,
    );
    const visible = allDocs.filter((d) => readable.has(d.id));
    total = visible.length;

    let start = 0;
    if (cursor) {
      const pos = decodeListCursor(cursor);
      if (pos) {
        const idx = visible.findIndex(
          (d) =>
            d.updatedAt < pos.updatedAt ||
            (d.updatedAt.getTime() === pos.updatedAt.getTime() && d.id < pos.id),
        );
        start = idx === -1 ? visible.length : idx;
      }
    }
    const pageLimit = limit ?? visible.length;
    const page = visible.slice(start, start + pageLimit) as DocRow[];
    if (start + pageLimit < visible.length) {
      const last = page[page.length - 1];
      nextCursor = last ? encodeListCursor(last.updatedAt, last.id) : null;
    }
    docs = page;
  } else {
    // Keyset pagination: no cursor = first page (no seek condition).
    const pos = cursor ? decodeListCursor(cursor) : null;
    const seekCondition = pos
      ? and(
          baseCondition,
          or(
            lt(document.updatedAt, pos.updatedAt),
            and(sql`${document.updatedAt} = ${pos.updatedAt}`, lt(document.id, pos.id)),
          ),
        )
      : baseCondition;

    const fetchLimit = (limit ?? 50) + 1;
    const rows = (await many(
      s.db
        .select(selectFields)
        .from(document)
        .where(seekCondition)
        .orderBy(desc(document.updatedAt), desc(document.id))
        .limit(fetchLimit),
    )) as DocRow[];

    if (rows.length === fetchLimit) {
      docs = rows.slice(0, -1);
      const last = docs[docs.length - 1];
      nextCursor = last ? encodeListCursor(last.updatedAt, last.id) : null;
    } else {
      docs = rows;
    }
    total = 0;
  }

  // Fetch properties only for the documents on this page
  const docIds = docs.map((d) => d.id);
  const allProps =
    docIds.length > 0
      ? await many(
          s.db.select().from(property).where(inArray(property.documentId, docIds)),
        )
      : [];

  // Group properties by document ID
  const propsByDocId = toDocumentPropertiesByDocument(allProps);

  // Build results
  const results: DocumentWithProperties[] = docs.map((doc) => ({
    id: doc.id,
    slug: doc.slug,
    type: doc.type || "document",
    content: "", // Empty content for list view - fetch separately when viewing
    currentRev: doc.currentRev,
    publishedRev: doc.publishedRev,
    changeSeq: doc.changeSeq,
    properties: propsByDocId.get(doc.id) || {},
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    createdBy: doc.createdBy,
    parentId: doc.parentId || null,
    readonly: doc.readonly,
    archived: doc.archived,
  }));

  if (type === "file" || (includeFiles && !type)) {
    await syncFileIndex(s).catch(() => {});

    const visibleFiles = await filterAccessibleFiles(
      s.spaceId,
      await many(s.db.select().from(fileTable).orderBy(desc(fileTable.updatedAt))),
      viewer,
    );

    const fileResults = visibleFiles.map(fileRowToDocument);

    if (type === "file") {
      return { documents: fileResults, total: fileResults.length, nextCursor: null };
    }

    // Only include files on the first page — subsequent cursor pages contain
    // documents only, so files aren't duplicated across pages.
    if (!cursor) {
      results.push(...fileResults);
      total += fileResults.length;
    }
  }

  return { documents: results, total, nextCursor };
}

export async function listArchivedDocuments(
  s: SpaceStore,
  viewer: AclViewer | null,
  options?: { limit?: number; cursor?: string },
): Promise<{ documents: DocumentWithProperties[]; nextCursor: string | null }> {
  let docs = await many(
    s.db
      .select({
        id: document.id,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        parentId: document.parentId,
        publishedRev: document.publishedRev,
        slug: document.slug,
        type: document.type,
        currentRev: document.currentRev,
        changeSeq: document.changeSeq,
        createdBy: document.createdBy,
        readonly: document.readonly,
        archived: document.archived,
      })
      .from(document)
      .where(archivedDocumentCondition)
      .orderBy(desc(document.updatedAt), desc(document.id)),
  );

  // Per-document ACL filtering, mirroring listDocuments: space access alone must
  // not expose archived documents the caller cannot read — at `editor`, which is
  // what reading one takes.
  if (viewer) {
    const readable = await filterReadableResources(
      s.spaceId,
      ResourceType.DOCUMENT,
      docs.map((doc) => doc.id),
      viewer,
      Permission.EDITOR,
    );
    docs = docs.filter((doc) => readable.has(doc.id));
  }

  const archivedIds = docs.map((doc) => doc.id);
  const allProps = archivedIds.length
    ? await many(
        s.db.select().from(property).where(inArray(property.documentId, archivedIds)),
      )
    : [];

  const propsByDocId = toDocumentPropertiesByDocument(allProps);

  const results: DocumentWithProperties[] = docs.map((doc) => ({
    id: doc.id,
    slug: doc.slug,
    type: doc.type,
    content: "",
    currentRev: doc.currentRev,
    publishedRev: doc.publishedRev,
    changeSeq: doc.changeSeq,
    properties: propsByDocId.get(doc.id) || {},
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    createdBy: doc.createdBy,
    parentId: doc.parentId || null,
    readonly: doc.readonly,
    archived: doc.archived,
  }));

  const limit = options?.limit ?? 50;
  let start = 0;
  if (options?.cursor) {
    const pos = decodeListCursor(options.cursor);
    if (pos) {
      const idx = results.findIndex(
        (d) =>
          d.updatedAt < pos.updatedAt ||
          (d.updatedAt.getTime() === pos.updatedAt.getTime() && d.id < pos.id),
      );
      start = idx === -1 ? results.length : idx;
    }
  }

  const page = results.slice(start, start + limit);
  const last = page[page.length - 1];
  const nextCursor =
    start + limit < results.length && last
      ? encodeListCursor(last.updatedAt, last.id)
      : null;
  return { documents: page, nextCursor };
}

/**
 * Cache for mention counts
 * Key format: `${documentId}:${publishedRev}:${userEmail}`
 */
const mentionCountCache = new Map<string, number>();

/**
 * Invalidate mention count cache for a specific document
 */
export function invalidateMentionCache(documentId: string) {
  const keysToDelete: string[] = [];
  for (const key of mentionCountCache.keys()) {
    if (key.startsWith(`${documentId}:`)) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    mentionCountCache.delete(key);
  }
}

/**
 * Count mentions of a specific user email in a document's published revision
 * Results are cached in memory to avoid recomputing on every request
 */
async function countMentionsForUser(
  s: SpaceStore,
  documentId: string,
  userEmail: string,
): Promise<number> {
  const doc = await one(
    s.db
      .select({
        publishedRev: document.publishedRev,
        type: document.type,
      })
      .from(document)
      .where(eq(document.id, documentId)),
  );

  if (!doc?.publishedRev || isSerializedDocumentType(doc.type)) {
    return 0;
  }

  const cacheKey = `${documentId}:${doc.publishedRev}:${userEmail}`;

  const cached = mentionCountCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const rev = await one(
    s.db
      .select({
        snapshot: revision.snapshot,
      })
      .from(revision)
      .where(
        and(eq(revision.documentId, documentId), eq(revision.rev, doc.publishedRev)),
      ),
  );

  if (!rev?.snapshot) {
    return 0;
  }

  try {
    const html = decompressRevisionContent(rev.snapshot);
    const mentions = extractMentionsFromHtml(html);
    const count = mentions.filter((m) => m.email === userEmail).length;

    mentionCountCache.set(cacheKey, count);

    return count;
  } catch (error) {
    appLogger.error("Failed to count mentions", { error });
    return 0;
  }
}

/**
 * List documents for multiple categories in one pass.
 * For each category slug, includes documents directly in that category plus all descendants.
 *
 * Returns a `Map`, not a `Record`: the slugs come straight off the query string,
 * and `result["__proto__"] = docs` on an object literal reassigns the prototype
 * instead of storing the bucket — the slug then vanishes from `Object.entries`
 * and the caller reads `Object.prototype` back in its place, which is not an
 * array and so 500s the whole listing.
 */
export async function listAllDocumentsByCategories(
  s: SpaceStore,
  categorySlugs: string[],
  viewer: AclViewer | null,
  userEmail?: string,
): Promise<Map<string, DocumentWithProperties[]>> {
  const uniqueSlugs = Array.from(new Set(categorySlugs.filter(Boolean)));
  if (uniqueSlugs.length === 0) {
    return new Map();
  }

  let docs = await many(
    s.db
      .select({
        id: document.id,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        parentId: document.parentId,
        publishedRev: document.publishedRev,
        slug: document.slug,
        type: document.type,
        currentRev: document.currentRev,
        changeSeq: document.changeSeq,
        createdBy: document.createdBy,
        readonly: document.readonly,
        archived: document.archived,
      })
      .from(document)
      .where(nonArchivedDocumentCondition)
      .orderBy(desc(document.updatedAt), desc(document.id)),
  );

  const parentByIdAll = new Map<string, string | null>(
    docs.map((doc) => [doc.id, doc.parentId || null]),
  );

  const readableIds = viewer
    ? await filterReadableResources(
        s.spaceId,
        ResourceType.DOCUMENT,
        docs.map((doc) => doc.id),
        viewer,
      )
    : new Set<string>(docs.map((doc) => doc.id));

  const includedIds = new Set<string>(readableIds);
  for (const id of readableIds) {
    let parentId = parentByIdAll.get(id);
    while (parentId && !includedIds.has(parentId)) {
      includedIds.add(parentId);
      parentId = parentByIdAll.get(parentId);
    }
  }
  const lockedIds = new Set<string>(
    [...includedIds].filter((id) => !readableIds.has(id)),
  );

  docs = docs.filter((doc) => includedIds.has(doc.id));

  const allProps = await many(s.db.select().from(property));
  const propsByDocId = toDocumentPropertiesByDocument(allProps);

  const typeFilteredResults: DocumentWithProperties[] = docs.map((doc) => ({
    id: doc.id,
    slug: doc.slug,
    type: doc.type || "document",
    content: "",
    currentRev: doc.currentRev,
    publishedRev: doc.publishedRev,
    changeSeq: doc.changeSeq,
    properties: propsByDocId.get(doc.id) || {},
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    createdBy: doc.createdBy,
    parentId: doc.parentId || null,
    readonly: doc.readonly,
    archived: doc.archived,
    locked: lockedIds.has(doc.id),
  }));

  const docIdsBySlug = new Map<string, Set<string>>();
  for (const slug of uniqueSlugs) {
    docIdsBySlug.set(slug, new Set<string>());
  }

  // A document shows under every category tagged on itself or any ancestor, and
  // brings its whole ancestor chain into that bucket so the tree can nest it.
  for (const doc of typeFilteredResults) {
    const chain: string[] = [];
    for (let id: string | null | undefined = doc.id; id; id = parentByIdAll.get(id)) {
      chain.push(id);
    }

    const slugs = new Set<string>();
    for (const id of chain) {
      const props = propsByDocId.get(id);
      for (const value of [props?.category, props?.collection]) {
        for (const slug of Array.isArray(value) ? value : value ? [value] : []) {
          if (docIdsBySlug.has(slug)) slugs.add(slug);
        }
      }
    }

    for (const slug of slugs) {
      const bucket = docIdsBySlug.get(slug);
      if (bucket) for (const id of chain) bucket.add(id);
    }
  }

  const mentionCountByDocId = new Map<string, number>();
  if (userEmail) {
    const docIds = new Set<string>();
    for (const ids of docIdsBySlug.values()) {
      for (const id of ids) {
        docIds.add(id);
      }
    }

    await Promise.all(
      Array.from(docIds).map(async (docId) => {
        const count = await countMentionsForUser(s, docId, userEmail);
        mentionCountByDocId.set(docId, count);
      }),
    );
  }

  const result = new Map<string, DocumentWithProperties[]>();

  for (const slug of uniqueSlugs) {
    const ids = docIdsBySlug.get(slug) || new Set<string>();
    const bucket = typeFilteredResults
      .filter((doc) => ids.has(doc.id))
      .map((doc) => {
        const base = doc.locked
          ? {
              ...doc,
              properties: doc.properties.title ? { title: doc.properties.title } : {},
            }
          : doc;
        if (!userEmail || doc.locked) return base;
        return {
          ...base,
          mentionCount: mentionCountByDocId.get(doc.id) || 0,
        };
      });
    result.set(slug, bucket);
  }

  return result;
}

export async function setDocumentParent(
  s: SpaceStore,
  documentId: string,
  parentId: string | null,
): Promise<{
  documentId: string;
  previousParentId: string | null;
  parentId: string | null;
}> {
  return s.tx(async (tx) => {
    const existing = await one(
      tx.db
        .select({ parentId: document.parentId, type: document.type })
        .from(document)
        .where(eq(document.id, documentId)),
    );

    if (!existing) throw new InvalidDocumentParentError("Child document not found");
    if (parentId === documentId) {
      throw new InvalidDocumentParentError(
        "Cannot set parent: document cannot be its own parent",
      );
    }

    if (parentId) {
      await assertDocumentCanParent(tx, parentId, existing.type);

      let ancestorId: string | null = parentId;
      const visited = new Set<string>();
      while (ancestorId) {
        if (ancestorId === documentId || visited.has(ancestorId)) {
          throw new InvalidDocumentParentError(
            "Cannot set parent: this would create a document cycle",
          );
        }
        visited.add(ancestorId);

        // Annotated: inferring the row from a query keyed on `ancestorId`, which
        // the next line reassigns from that same row, is circular to TypeScript.
        const currentId: string = ancestorId;
        const ancestor = await one(
          tx.db
            .select({ parentId: document.parentId })
            .from(document)
            .where(eq(document.id, currentId)),
        );
        if (!ancestor) break;
        ancestorId = ancestor.parentId;
      }
    }

    await touchDocument(tx, documentId, { parentId, updatedAt: new Date() });

    return {
      documentId,
      previousParentId: existing.parentId ?? null,
      parentId,
    };
  });
}

export async function getDocumentChildren(
  s: SpaceStore,
  parentId: string,
  viewer: AclViewer | null,
): Promise<DocumentWithProperties[]> {
  let docs = await many(
    s.db
      .select()
      .from(document)
      .where(and(eq(document.parentId, parentId), nonArchivedDocumentCondition)),
  );

  // Per-document ACL filtering: a caller with access to the parent must not be
  // able to enumerate (or read the content of) children they cannot access.
  // A null viewer is a trusted system caller and sees everything.
  if (viewer) {
    const readable = await filterReadableResources(
      s.spaceId,
      ResourceType.DOCUMENT,
      docs.map((doc) => doc.id),
      viewer,
    );
    docs = docs.filter((doc) => readable.has(doc.id));
  }

  const childIds = docs.map((d) => d.id);
  const allProps =
    childIds.length > 0
      ? await many(
          s.db.select().from(property).where(inArray(property.documentId, childIds)),
        )
      : [];

  const propsByDocId = toDocumentPropertiesByDocument(allProps);

  return docs.map((doc) => ({
    id: doc.id,
    slug: doc.slug,
    type: doc.type,
    content: "",
    currentRev: doc.currentRev,
    publishedRev: doc.publishedRev,
    changeSeq: doc.changeSeq,
    properties: propsByDocId.get(doc.id) ?? {},
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    createdBy: doc.createdBy,
    parentId: doc.parentId || null,
    readonly: doc.readonly,
    archived: doc.archived,
  }));
}

export interface BreadcrumbItem {
  id: string;
  slug: string;
  title: string;
  categorySlug?: string;
}

export async function getDocumentBreadcrumbs(
  s: SpaceStore,
  documentId: string,
): Promise<BreadcrumbItem[]> {
  const breadcrumbs: BreadcrumbItem[] = [];

  let currentId: string | null = documentId;
  const visited = new Set<string>();

  while (currentId) {
    if (visited.has(currentId)) {
      break;
    }
    visited.add(currentId);

    // Fixed before the query: `currentId` is reassigned from the row this loads,
    // and inferring the row's type through a narrowed `currentId` is circular.
    const id: string = currentId;
    const doc = await one(
      s.db
        .select({
          id: document.id,
          slug: document.slug,
          parentId: document.parentId,
        })
        .from(document)
        .where(eq(document.id, id)),
    );

    if (!doc) {
      break;
    }

    const props = await many(
      s.db
        .select()
        .from(property)
        .where(
          and(
            eq(property.documentId, doc.id),
            inArray(property.key, ["title", "category"]),
          ),
        ),
    );

    const titleValue = props.find((p) => p.key === "title")?.value;
    const categoryValue = props.find((p) => p.key === "category")?.value;
    const title = titleValue
      ? propertyValueToText(parseStoredPropertyValue(titleValue))
      : "Untitled";
    const categorySlug = categoryValue
      ? propertyValueToScalar(parseStoredPropertyValue(categoryValue))
      : undefined;

    breadcrumbs.unshift({
      id: doc.id,
      slug: doc.slug,
      title,
      ...(categorySlug ? { categorySlug } : {}),
    });

    currentId = doc.parentId;
  }

  return breadcrumbs;
}
