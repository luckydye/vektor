import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { type AclViewer, Permission, ResourceType } from "#acl/permissions.ts";
import { filterReadableResources, revokePermission } from "#acl/store.ts";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { decodeSeekCursor, encodeSeekCursor } from "#db/cursor.ts";
import { createId } from "#db/ids.ts";
import { document, file as fileTable, property, revision } from "#db/schema/space.ts";
import { extractMentionsFromHtml } from "#documents/mentions.ts";
import {
  type DocumentPropertyValue,
  parseStoredPropertyValue,
  propertyValueToScalar,
  propertyValueToText,
  serializePropertyValue,
} from "#documents/properties.ts";
import {
  allowsChildDocumentType,
  isPlaceholderDocumentSlug,
  readOnlyDocumentTypes,
} from "#documents/types.ts";
import { extractFileTextFromBuffer } from "#files/extractText.ts";
import { getFileStorage } from "#files/storage.ts";
import { appLogger } from "#observability/logger.ts";
import { slugify } from "#utils/utils.ts";
import { createAuditLog } from "./auditLogs.ts";
import { deleteDocumentEmailPreferences } from "./emailNotificationPreferences.ts";
import { decompressHtml } from "./revisions.ts";
import {
  type DocumentWithProperties,
  fileRowToDocument,
  nonArchivedDocumentCondition,
  updateDocumentEmbedding,
} from "./search.ts";

export type {
  DocumentWithProperties,
  FileRow,
  PropertyFilter,
  SearchResult,
} from "./search.ts";
export { rebuildSearchIndex, searchDocuments } from "./search.ts";

const archivedDocumentCondition = sql`
  (
    ${document.archived} = 1
    OR ${document.archived} = '1'
    OR ${document.archived} = '1.0'
    OR ${document.archived} = TRUE
  )
`;

async function updateDocumentEmbeddingBestEffort(
  s: SpaceStore,
  documentId: string,
): Promise<void> {
  try {
    await updateDocumentEmbedding(s, documentId);
  } catch (error) {
    appLogger.warn("Failed to update document embedding", {
      error,
      spaceId: s.spaceId,
      documentId,
    });
  }
}

/**
 * A title with nothing sluggable in it (e.g. "-----") leaves no usable URL, so
 * it is a bad request rather than a server fault.
 */
export class EmptyDocumentSlugError extends Error {}

async function generateUniqueSlug(
  s: SpaceStore,
  baseTitle: string,
  excludeDocumentId?: string,
): Promise<string> {
  const baseSlug = slugify(baseTitle);
  if (!baseSlug) {
    throw new EmptyDocumentSlugError("Title must contain at least one letter or number");
  }

  // Get all existing slugs in the space
  const allDocs = await many(
    s.db.select({ id: document.id, slug: document.slug }).from(document),
  );

  const existingSlugs = new Set(
    allDocs.filter((d) => d.id !== excludeDocumentId).map((d) => d.slug),
  );

  // If the base slug is available, use it
  if (!existingSlugs.has(baseSlug)) {
    return baseSlug;
  }

  // Otherwise, append a counter to make it unique
  let slug = baseSlug;
  let counter = 1;

  while (existingSlugs.has(slug)) {
    slug = `${baseSlug}-${counter}`;
    counter++;
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
  initialProperties?: Record<string, PropertyInit>,
  parentId?: string | null,
  type?: string,
  createdAt?: Date,
  updatedAt?: Date,
): Promise<DocumentWithProperties> {
  if (parentId) await assertDocumentCanParent(s, parentId, type);
  const id = createId("document");
  const now = new Date();
  const documentCreatedAt = createdAt || now;
  const documentUpdatedAt = updatedAt || now;
  const isReadonly = readOnlyDocumentTypes.includes(type ?? "");

  // Generate a unique slug if the provided slug already exists
  const uniqueSlug = await generateUniqueSlug(s, slug);

  await s.db.insert(document).values({
    id,
    slug: uniqueSlug,
    type: type || null,
    content,
    currentRev: 0,
    publishedRev: null,
    createdBy: createdBy,
    parentId: parentId || null,
    archived: false,
    readonly: isReadonly,
    createdAt: documentCreatedAt,
    updatedAt: documentUpdatedAt,
  });

  const properties = initialProperties || {};
  const storedProperties: Record<string, DocumentPropertyValue> = {};

  for (const [key, raw] of Object.entries(properties)) {
    const isWrappedValue =
      typeof raw === "object" && raw !== null && !Array.isArray(raw) && "value" in raw;
    const propValue = isWrappedValue ? raw.value : raw;
    const propType = isWrappedValue ? (raw.type ?? null) : null;
    const storedValue = serializePropertyValue(propValue);
    storedProperties[key] = parseStoredPropertyValue(storedValue);
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

  await updateDocumentEmbeddingBestEffort(s, id);

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
    properties: storedProperties,
    createdAt: documentCreatedAt,
    updatedAt: documentUpdatedAt,
    createdBy: createdBy,
    parentId: parentId || null,
    readonly: isReadonly,
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
  const properties: Record<string, DocumentPropertyValue> = {};
  for (const prop of props) {
    properties[prop.key] = parseStoredPropertyValue(prop.value);
  }

  return { ...doc, parentId: doc.parentId || null, properties };
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

  const propertiesByDocument = new Map<string, Record<string, DocumentPropertyValue>>();
  for (const prop of props) {
    const properties = propertiesByDocument.get(prop.documentId) ?? {};
    properties[prop.key] = parseStoredPropertyValue(prop.value);
    propertiesByDocument.set(prop.documentId, properties);
  }

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
 * What an auth check needs to know about a document: that it exists, and
 * whether it is archived (which raises the role required to reach it). Returns
 * null when there is no such document.
 *
 * Selects neither the content nor the properties — using getDocument here would
 * pull the entire `content` column (tens of MB for large canvases) into memory
 * on every request, which saturated the server under presence/collaboration
 * traffic. `archived` is derived with the same condition the listings use, so a
 * legacy row that stored the flag as `'1'` or `'1.0'` reads as archived here too.
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

  const properties: Record<string, DocumentPropertyValue> = {};
  for (const prop of props) {
    properties[prop.key] = parseStoredPropertyValue(prop.value);
  }

  return {
    id: doc.id,
    slug: doc.slug,
    type: doc.type,
    content: doc.content,
    currentRev: doc.currentRev,
    publishedRev: doc.publishedRev,
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
): Promise<DocumentWithProperties | null> {
  // getDocument is metadata-only — `existing.content` is never read here (the
  // write uses the new `content`), so we avoid loading the old content (tens of
  // MB on large canvases) every save.
  const existing = await getDocument(s, id);
  if (!existing) {
    return null;
  }

  const now = new Date();
  const nextType = type === undefined ? existing.type : type;
  const nextReadonly =
    existing.readonly || readOnlyDocumentTypes.includes(nextType ?? "");

  await s.db
    .update(document)
    .set({ content, updatedAt: now, type: nextType, readonly: nextReadonly })
    .where(eq(document.id, id));

  await updateDocumentEmbeddingBestEffort(s, id);

  return {
    id,
    slug: existing.slug,
    content,
    currentRev: existing.currentRev,
    publishedRev: existing.publishedRev,
    properties: existing.properties,
    createdAt: existing.createdAt,
    updatedAt: now,
    createdBy: existing.createdBy,
    parentId: existing.parentId,
    readonly: nextReadonly,
    type: nextType,
    archived: existing.archived,
  };
}

/**
 * Drop every ACL grant that names this document, for a document that is going
 * away for good.
 *
 * Archiving does NOT do this — an archived document keeps its grants and is
 * withheld from viewers by raising the role its access requires (see
 * `requiredRoleForDocument`), so restoring it restores its shares too. Only a
 * permanent delete purges the rows, because the resource they point at ceases
 * to exist. `revokePermission` audit-logs each removed grant.
 */
async function revokeDocumentGrants(
  s: SpaceStore,
  id: string,
  actorUserId?: string,
): Promise<void> {
  await revokePermission(
    s.spaceId,
    ResourceType.DOCUMENT,
    id,
    undefined,
    undefined,
    actorUserId,
  );
  await revokePermission(
    s.spaceId,
    ResourceType.DOCUMENT_TREE,
    id,
    undefined,
    undefined,
    actorUserId,
  );
}

export async function archiveDocument(
  s: SpaceStore,
  id: string,
  userId?: string,
): Promise<boolean> {
  await s.tx(async (tx) => {
    if (userId) {
      await createAuditLog(tx, {
        spaceId: tx.spaceId,
        docId: id,
        userId,
        event: "archive",
        details: { message: "Document archived" },
      });
    }

    await tx.db
      .update(document)
      .set({ archived: true, updatedAt: new Date() })
      .where(eq(document.id, id));
  });

  return true;
}

/**
 * Clearing `archived` is all a restore has to do: the document's grants were
 * never revoked, they simply stopped resolving for viewers while it sat in the
 * trash, so the shares it had come back with it.
 */
export async function restoreDocument(
  s: SpaceStore,
  id: string,
  userId?: string,
): Promise<boolean> {
  if (userId) {
    await createAuditLog(s, {
      spaceId: s.spaceId,
      docId: id,
      userId,
      event: "restore",
      details: { message: "Document restored" },
    });
  }

  await s.db
    .update(document)
    .set({ archived: false, updatedAt: new Date() })
    .where(eq(document.id, id));

  return true;
}

export async function deleteDocument(
  s: SpaceStore,
  id: string,
  userId?: string,
): Promise<boolean> {
  if (userId) {
    await createAuditLog(s, {
      spaceId: s.spaceId,
      docId: id,
      userId,
      event: "delete",
      details: { message: "Document deleted" },
    });
  }

  await deleteDocumentEmailPreferences(await openSpaceStore(s.spaceId), id);
  // SQLite runs with `PRAGMA foreign_keys = 0`, so dropping the document row
  // does not cascade — the grants pointing at it would outlive it and be
  // inherited by the next document to reuse the id.
  await revokeDocumentGrants(s, id, userId);
  await s.db.delete(document).where(eq(document.id, id));

  return true;
}

async function syncFileIndex(s: SpaceStore): Promise<void> {
  const storage = getFileStorage();
  const diskFiles = await storage.list(s.spaceId);
  if (diskFiles.length === 0) return;

  const indexed = new Set(
    (await many(s.db.select({ path: fileTable.path }).from(fileTable))).map(
      (r) => r.path,
    ),
  );

  const toIndex = diskFiles.filter((f) => !indexed.has(f.key)).slice(0, 200);

  for (const { key, updatedAt } of toIndex) {
    const buf = await storage.read(s.spaceId, key);
    if (!buf) continue;
    const name = key.split("/").pop() ?? key;
    const extracted = extractFileTextFromBuffer(buf, name, undefined);
    const url = storage.url(s.spaceId, key);
    await s.db
      .insert(fileTable)
      .values({
        path: key,
        documentId: null,
        originalName: name,
        mimeType: null,
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
  const propsByDocId = new Map<string, Record<string, DocumentPropertyValue>>();
  for (const prop of allProps) {
    const docProps = propsByDocId.get(prop.documentId) ?? {};
    docProps[prop.key] = parseStoredPropertyValue(prop.value);
    propsByDocId.set(prop.documentId, docProps);
  }

  // Build results
  const results: DocumentWithProperties[] = docs.map((doc) => ({
    id: doc.id,
    slug: doc.slug,
    type: doc.type || "document",
    content: "", // Empty content for list view - fetch separately when viewing
    currentRev: doc.currentRev,
    publishedRev: doc.publishedRev,
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

    let visibleFiles = await many(
      s.db.select().from(fileTable).orderBy(desc(fileTable.updatedAt)),
    );

    if (viewer) {
      const parentDocumentIds = [
        ...new Set(
          visibleFiles
            .map((file) => file.documentId)
            .filter((documentId): documentId is string => documentId !== null),
        ),
      ];
      const readableParentIds = await filterReadableResources(
        s.spaceId,
        ResourceType.DOCUMENT,
        parentDocumentIds,
        viewer,
      );
      visibleFiles = visibleFiles.filter((file) =>
        file.documentId === null
          ? // A file attached to no document is a space-wide upload, readable
            // by anyone in the space but not reachable through any one grant.
            !viewer.documentScope
          : readableParentIds.has(file.documentId),
      );
    }

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
        createdBy: document.createdBy,
        readonly: document.readonly,
        archived: document.archived,
      })
      .from(document)
      .where(archivedDocumentCondition)
      .orderBy(desc(document.updatedAt), desc(document.id)),
  );

  // Per-document ACL filtering, mirroring listDocuments. Space access alone
  // must not expose archived documents the caller cannot read — and reading an
  // archived document takes `editor`, so a viewer-level grant does not list it
  // here either.
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

  const allProps = await many(s.db.select().from(property));

  const propsByDocId = new Map<string, Record<string, DocumentPropertyValue>>();
  for (const prop of allProps) {
    const docProps = propsByDocId.get(prop.documentId) ?? {};
    docProps[prop.key] = parseStoredPropertyValue(prop.value);
    propsByDocId.set(prop.documentId, docProps);
  }

  const results: DocumentWithProperties[] = docs.map((doc) => ({
    id: doc.id,
    slug: doc.slug,
    type: doc.type,
    content: "",
    currentRev: doc.currentRev,
    publishedRev: doc.publishedRev,
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

export async function updateDocumentProperty(
  s: SpaceStore,
  documentId: string,
  key: string,
  value: DocumentPropertyValue,
  type?: string | null,
  userId?: string,
): Promise<{ slug?: string }> {
  const now = new Date();
  const storedValue = serializePropertyValue(value);

  // Read existing value for audit log (indexed lookup, very fast)
  const existing = await one(
    s.db
      .select()
      .from(property)
      .where(and(eq(property.documentId, documentId), eq(property.key, key))),
  );

  const previousValue = existing ? parseStoredPropertyValue(existing.value) : undefined;

  if (existing) {
    const updateData: { value: string; updatedAt: Date; type?: string | null } = {
      value: storedValue,
      updatedAt: now,
    };
    if (type !== undefined) updateData.type = type;
    await s.db.update(property).set(updateData).where(eq(property.id, existing.id));
  } else {
    await s.db.insert(property).values({
      id: createId("property"),
      documentId,
      key,
      value: storedValue,
      type: type || null,
      createdAt: now,
      updatedAt: now,
    });
  }

  await createAuditLog(s, {
    spaceId: s.spaceId,
    docId: documentId,
    userId,
    event: "property_update",
    details: {
      propertyKey: key,
      propertyType: type || undefined,
      previousValue: previousValue ? propertyValueToText(previousValue) : undefined,
      newValue: propertyValueToText(value),
    },
  });

  // A rename leaves the slug alone so existing links and bookmarks keep
  // resolving. The exception is a slug still derived from the placeholder title
  // the document was created with — that one names nothing, so the first real
  // title claims it.
  let renamedSlug: string | undefined;
  if (key === "title" && typeof value === "string" && value) {
    const current = await one(
      s.db
        .select({ slug: document.slug })
        .from(document)
        .where(eq(document.id, documentId)),
    );

    if (current && isPlaceholderDocumentSlug(current.slug)) {
      // An unsluggable title still renames the document; only the derived slug
      // can't follow, so it stays where it was.
      renamedSlug = await generateUniqueSlug(s, value, documentId).catch(
        (error: unknown) => {
          if (error instanceof EmptyDocumentSlugError) return undefined;
          throw error;
        },
      );
    }
  }

  await s.db
    .update(document)
    .set({ ...(renamedSlug ? { slug: renamedSlug } : {}), updatedAt: now })
    .where(eq(document.id, documentId));

  void updateDocumentEmbeddingBestEffort(s, documentId);
  const propertyChangeData = {
    kind: "document_property_changed",
    documentId,
    propertyKey: key,
    propertyType: type ?? existing?.type ?? null,
    previousValue: previousValue ?? null,
    value,
  };
  const treeRelevantProperty = ["title", "category", "collection"].includes(key);

  s.emit({
    kind: "documentProperty",
    documentId,
    affectsTree: treeRelevantProperty,
    data: propertyChangeData,
  });

  return renamedSlug ? { slug: renamedSlug } : {};
}

export async function deleteDocumentProperty(
  s: SpaceStore,
  documentId: string,
  key: string,
  userId?: string,
): Promise<void> {
  const now = new Date();

  // Get the property value before deletion for audit log
  const existing = await one(
    s.db
      .select()
      .from(property)
      .where(and(eq(property.documentId, documentId), eq(property.key, key))),
  );

  await s.db
    .delete(property)
    .where(and(eq(property.documentId, documentId), eq(property.key, key)));

  // Create audit log for property deletion
  if (existing) {
    await createAuditLog(s, {
      spaceId: s.spaceId,
      docId: documentId,
      userId,
      event: "property_delete",
      details: {
        propertyKey: key,
        propertyType: existing.type || undefined,
        previousValue: propertyValueToText(parseStoredPropertyValue(existing.value)),
      },
    });
  }

  // Update the document's updatedAt timestamp
  await s.db.update(document).set({ updatedAt: now }).where(eq(document.id, documentId));

  void updateDocumentEmbeddingBestEffort(s, documentId);
  const propertyDeleteData = {
    kind: "document_property_deleted",
    documentId,
    propertyKey: key,
    propertyType: existing?.type ?? null,
    previousValue: existing ? parseStoredPropertyValue(existing.value) : null,
  };
  const treeRelevantProperty = ["title", "category", "collection"].includes(key);

  s.emit({
    kind: "documentProperty",
    documentId,
    affectsTree: treeRelevantProperty,
    data: propertyDeleteData,
  });
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
      })
      .from(document)
      .where(eq(document.id, documentId)),
  );

  if (!doc?.publishedRev) {
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
    const html = decompressHtml(rev.snapshot);
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
 */
export async function listAllDocumentsByCategories(
  s: SpaceStore,
  categorySlugs: string[],
  viewer: AclViewer | null,
  userEmail?: string,
): Promise<Record<string, DocumentWithProperties[]>> {
  const uniqueSlugs = Array.from(new Set(categorySlugs.filter(Boolean)));
  if (uniqueSlugs.length === 0) {
    return {};
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
        createdBy: document.createdBy,
        readonly: document.readonly,
        archived: document.archived,
      })
      .from(document)
      .where(nonArchivedDocumentCondition)
      .orderBy(desc(document.updatedAt), desc(document.id)),
  );

  if (viewer) {
    const readable = await filterReadableResources(
      s.spaceId,
      ResourceType.DOCUMENT,
      docs.map((doc) => doc.id),
      viewer,
    );
    docs = docs.filter((doc) => readable.has(doc.id));
  }

  const allProps = await many(s.db.select().from(property));
  const propsByDocId = new Map<string, Record<string, DocumentPropertyValue>>();

  for (const prop of allProps) {
    const docProps = propsByDocId.get(prop.documentId) ?? {};
    docProps[prop.key] = parseStoredPropertyValue(prop.value);
    propsByDocId.set(prop.documentId, docProps);
  }

  const typeFilteredResults: DocumentWithProperties[] = docs.map((doc) => ({
    id: doc.id,
    slug: doc.slug,
    type: doc.type || "document",
    content: "",
    currentRev: doc.currentRev,
    publishedRev: doc.publishedRev,
    properties: propsByDocId.get(doc.id) || {},
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    createdBy: doc.createdBy,
    parentId: doc.parentId || null,
    readonly: doc.readonly,
    archived: doc.archived,
  }));

  const childrenByParentId = new Map<string, string[]>();
  for (const doc of typeFilteredResults) {
    if (!doc.parentId) continue;
    const children = childrenByParentId.get(doc.parentId) || [];
    children.push(doc.id);
    childrenByParentId.set(doc.parentId, children);
  }

  const directDocIdsBySlug = new Map<string, Set<string>>();
  for (const slug of uniqueSlugs) {
    directDocIdsBySlug.set(slug, new Set<string>());
  }

  for (const doc of typeFilteredResults) {
    const categoryValues = [doc.properties.category, doc.properties.collection].flatMap(
      (value) => (Array.isArray(value) ? value : value ? [value] : []),
    );
    for (const category of categoryValues) {
      directDocIdsBySlug.get(category)?.add(doc.id);
    }
  }

  const docIdsBySlug = new Map<string, Set<string>>();

  for (const slug of uniqueSlugs) {
    const collected = new Set<string>(directDocIdsBySlug.get(slug) || []);
    const stack = Array.from(collected);

    while (stack.length > 0) {
      const parentId = stack.pop();
      if (!parentId) continue;
      const childIds = childrenByParentId.get(parentId) || [];
      for (const childId of childIds) {
        if (collected.has(childId)) continue;
        collected.add(childId);
        stack.push(childId);
      }
    }

    docIdsBySlug.set(slug, collected);
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

  const result: Record<string, DocumentWithProperties[]> = {};

  for (const slug of uniqueSlugs) {
    const ids = docIdsBySlug.get(slug) || new Set<string>();
    result[slug] = typeFilteredResults
      .filter((doc) => ids.has(doc.id))
      .map((doc) => {
        if (!userEmail) return doc;
        return {
          ...doc,
          mentionCount: mentionCountByDocId.get(doc.id) || 0,
        };
      });
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
  const now = new Date();
  const existing = await one(
    s.db
      .select({ parentId: document.parentId, type: document.type })
      .from(document)
      .where(eq(document.id, documentId)),
  );

  if (parentId === documentId) {
    throw new Error("Cannot set parent: a child cant be a parent");
  }
  if (!existing) throw new InvalidDocumentParentError("Child document not found");
  if (parentId) await assertDocumentCanParent(s, parentId, existing.type);

  await s.db
    .update(document)
    .set({ parentId, updatedAt: now })
    .where(eq(document.id, documentId));

  return {
    documentId,
    previousParentId: existing?.parentId ?? null,
    parentId,
  };
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

  const propsByDocId = new Map<string, Record<string, DocumentPropertyValue>>();
  for (const prop of allProps) {
    const docProps = propsByDocId.get(prop.documentId) ?? {};
    docProps[prop.key] = parseStoredPropertyValue(prop.value);
    propsByDocId.set(prop.documentId, docProps);
  }

  return docs.map((doc) => ({
    id: doc.id,
    slug: doc.slug,
    type: doc.type,
    content: "",
    currentRev: doc.currentRev,
    publishedRev: doc.publishedRev,
    properties: propsByDocId.get(doc.id) ?? {},
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    createdBy: doc.createdBy,
    parentId: doc.parentId || null,
    readonly: doc.readonly,
    archived: doc.archived,
  }));
}

export interface PropertyInfo {
  name: string;
  type: string | null;
  values: string[];
}

export async function getAllPropertiesWithValues(s: SpaceStore): Promise<PropertyInfo[]> {
  const allProperties = await many(s.db.select().from(property));

  const propertyMap: Record<string, { type: string | null; values: Set<string> }> = {};

  for (const prop of allProperties) {
    if (!propertyMap[prop.key]) {
      propertyMap[prop.key] = {
        type: prop.type || null,
        values: new Set(),
      };
    }
    const propValue = parseStoredPropertyValue(prop.value);
    const values = Array.isArray(propValue) ? propValue : [propValue];
    for (const value of values) {
      if (!value) continue;
      propertyMap[prop.key].values.add(value);
    }
    if (prop.type && !propertyMap[prop.key].type) {
      propertyMap[prop.key].type = prop.type;
    }
  }

  // Add document type as a virtual property
  const docTypes = await many(
    s.db
      .selectDistinct({ type: document.type })
      .from(document)
      .where(sql`${nonArchivedDocumentCondition}`),
  );

  const typeValues = docTypes
    .map((d) => d.type || "document")
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();

  if (!typeValues.includes("file")) {
    typeValues.push("file");
    typeValues.sort();
  }

  const result: PropertyInfo[] = [{ name: "type", type: "select", values: typeValues }];
  for (const [key, data] of Object.entries(propertyMap)) {
    result.push({
      name: key,
      type: data.type,
      values: Array.from(data.values).sort(),
    });
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
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
