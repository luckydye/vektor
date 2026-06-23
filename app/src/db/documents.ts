import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { extractFileTextFromBuffer } from "../files/extractText.ts";
import { getFileStorage } from "../files/storage.ts";
import { readOnlyDocumentTypes } from "../utils/documentTypes.ts";
import { realtimeTopics } from "../utils/realtime.ts";
import { normalizeTimestamp, slugify } from "../utils/utils.ts";
import {
  filterReadableResources,
  grantPermission,
  listAccessibleResources,
  Permission,
  ResourceType,
} from "./acl.ts";
import { createAuditLog } from "./auditLogs.ts";
import { getSpaceDb } from "./db.ts";
import { createId } from "./ids.ts";
import { extractMentionsFromHtml } from "./mentions.ts";
import { createRevision, decompressHtml } from "./revisions.ts";
import { document, file as fileTable, property, revision } from "./schema/space.ts";
import {
  buildDocumentSearchText,
  buildSearchSnippet,
  cosineSimilarity,
  embedText,
  parseEmbedding,
  scoreKeywordOverlap,
  serializeEmbedding,
} from "./searchEmbeddings.ts";
import { sendSyncEvent } from "./ws.ts";

const nonArchivedDocumentCondition = sql`
  (
    ${document.archived} = 0
    OR ${document.archived} = '0'
    OR ${document.archived} = '0.0'
    OR ${document.archived} IS NULL
    OR ${document.archived} = FALSE
  )
`;

const archivedDocumentCondition = sql`
  (
    ${document.archived} = 1
    OR ${document.archived} = '1'
    OR ${document.archived} = '1.0'
    OR ${document.archived} = TRUE
  )
`;

function nonArchivedColumnCondition(column: string) {
  return sql.raw(
    `(${column} = 0 OR ${column} = '0' OR ${column} = '0.0' OR ${column} IS NULL OR ${column} = FALSE)`,
  );
}

async function generateUniqueSlug(
  spaceId: string,
  baseTitle: string,
  excludeDocumentId?: string,
): Promise<string> {
  const db = await getSpaceDb(spaceId);

  const baseSlug = slugify(baseTitle);
  if (!baseSlug) {
    throw new Error("slug is empty");
  }

  // Get all existing slugs in the space
  const allDocs = await db
    .select({ id: document.id, slug: document.slug })
    .from(document)
    .all();

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

export async function updateDocumentEmbedding(
  spaceId: string,
  documentId: string,
): Promise<void> {
  const db = await getSpaceDb(spaceId);

  const doc = await db.select().from(document).where(eq(document.id, documentId)).get();

  if (!doc) {
    return;
  }

  if (doc.type === "canvas") {
    await db
      .update(document)
      .set({
        searchText: null,
        searchEmbedding: null,
        searchUpdatedAt: null,
      })
      .where(eq(document.id, documentId));
    return;
  }

  const props = await db
    .select()
    .from(property)
    .where(eq(property.documentId, documentId))
    .all();

  // Collect extracted text from files attached to this document
  const attachedFiles = await db
    .select()
    .from(fileTable)
    .where(eq(fileTable.documentId, documentId))
    .all();
  const fileTexts = attachedFiles.map((f) =>
    f.extractedText
      ? `[${f.originalName ?? f.path}]\n${f.extractedText}`
      : `[${f.originalName ?? f.path}]`,
  );

  const properties = Object.fromEntries(props.map((item) => [item.key, item.value]));
  const fileText = fileTexts.join("\n\n");
  const searchText = buildDocumentSearchText(
    doc.content,
    properties,
    fileText || undefined,
  );
  const searchEmbedding = serializeEmbedding(await embedText(searchText));

  await db
    .update(document)
    .set({
      searchText,
      searchEmbedding,
      searchUpdatedAt: new Date(),
    })
    .where(eq(document.id, documentId));
}

export interface DocumentWithProperties {
  id: string;
  slug: string;
  type?: string | null;
  content?: string;
  currentRev: number;
  publishedRev: number | null;
  properties: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  parentId: string | null;
  readonly: boolean;
  archived: boolean;
  mentionCount?: number;
  /** Set for file-table entries — use this URL instead of the doc route */
  fileUrl?: string;
}

export type SearchResult = DocumentWithProperties & {
  rank: number;
  snippet: string;
};

type FileRow = typeof fileTable.$inferSelect;

/** Map a standalone file-index row to the document shape used by listings and search. */
function fileRowToDocument(f: FileRow): DocumentWithProperties {
  return {
    id: f.path,
    slug: f.path,
    type: "file",
    content: "",
    currentRev: 0,
    publishedRev: null,
    properties: {
      ...(f.originalName ? { title: f.originalName } : {}),
      ...(f.mimeType ? { mimeType: f.mimeType } : {}),
    },
    createdAt: f.updatedAt ?? new Date(0),
    updatedAt: f.updatedAt ?? new Date(0),
    createdBy: "",
    parentId: null,
    readonly: true,
    archived: false,
    fileUrl: f.url ?? undefined,
  };
}

// Property filter for advanced search
// Use value: null to filter for documents that have the property (any value)
// Use value: string to filter for documents with that specific property value
export interface PropertyFilter {
  key: string;
  value: string | null;
}

type PropertyInit = string | { value: string; type?: string | null };

export async function createDocument(
  spaceId: string,
  createdBy: string,
  slug: string,
  content: string,
  initialProperties?: Record<string, PropertyInit>,
  parentId?: string | null,
  type?: string,
  createdAt?: Date,
  updatedAt?: Date,
): Promise<DocumentWithProperties> {
  const db = await getSpaceDb(spaceId);
  const id = createId("document");
  const now = new Date();
  const documentCreatedAt = createdAt || now;
  const documentUpdatedAt = updatedAt || now;
  const isReadonly = readOnlyDocumentTypes.includes(type ?? "");

  // Generate a unique slug if the provided slug already exists
  const uniqueSlug = await generateUniqueSlug(spaceId, slug);

  await db.insert(document).values({
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

  for (const [key, raw] of Object.entries(properties)) {
    const propValue = typeof raw === "object" && raw !== null ? raw.value : raw;
    const propType = typeof raw === "object" && raw !== null ? (raw.type ?? null) : null;
    await db.insert(property).values({
      id: createId("property"),
      documentId: id,
      key,
      value: propValue,
      type: propType,
      createdAt: now,
      updatedAt: now,
    });
  }

  await grantPermission(spaceId, ResourceType.DOCUMENT, id, createdBy, Permission.OWNER);

  await updateDocumentEmbedding(spaceId, id);

  const draftOnly = type === "canvas";
  if (!draftOnly) {
    await createRevision(spaceId, id, content, createdBy, {
      message: "Initial revision",
    });
  }

  await createAuditLog(await getSpaceDb(spaceId), {
    spaceId,
    docId: id,
    revisionId: draftOnly ? undefined : 1,
    userId: createdBy,
    event: "create",
    details: { message: "Document created" },
  });

  return {
    id,
    slug: uniqueSlug,
    type: type || null,
    content,
    currentRev: draftOnly ? 0 : 1,
    publishedRev: null,
    properties,
    createdAt: documentCreatedAt,
    updatedAt: documentUpdatedAt,
    createdBy: createdBy,
    parentId: parentId || null,
    readonly: isReadonly,
    archived: false,
  };
}

export async function getDocument(
  spaceId: string,
  id: string,
): Promise<DocumentWithProperties | null> {
  const db = await getSpaceDb(spaceId);
  const doc = await db.select().from(document).where(eq(document.id, id)).get();

  if (!doc) {
    return null;
  }

  const props = await db.select().from(property).where(eq(property.documentId, id)).all();

  const properties: Record<string, string> = {};
  for (const prop of props) {
    properties[prop.key] = prop.value;
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

export async function getDocumentBySlug(
  spaceId: string,
  slug: string,
): Promise<DocumentWithProperties | null> {
  const db = await getSpaceDb(spaceId);
  const doc = await db.select().from(document).where(eq(document.slug, slug)).get();

  if (!doc) {
    return null;
  }

  const props = await db
    .select()
    .from(property)
    .where(eq(property.documentId, doc.id))
    .all();

  const properties: Record<string, string> = {};
  for (const prop of props) {
    properties[prop.key] = prop.value;
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
  spaceId: string,
  id: string,
  content: string,
  userId?: string,
  type?: string | null,
): Promise<DocumentWithProperties | null> {
  const db = await getSpaceDb(spaceId);
  const existing = await getDocument(spaceId, id);
  if (!existing) {
    return null;
  }

  const now = new Date();
  const nextType = type === undefined ? existing.type : type;
  const nextReadonly = readOnlyDocumentTypes.includes(nextType ?? "");

  await db
    .update(document)
    .set({ content, updatedAt: now, type: nextType, readonly: nextReadonly })
    .where(eq(document.id, id));

  await updateDocumentEmbedding(spaceId, id);

  if (userId) {
    await createAuditLog(db, {
      spaceId,
      docId: id,
      userId,
      event: "save",
      details: { message: "Document updated" },
    });
  }

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

export async function archiveDocument(
  spaceId: string,
  id: string,
  userId?: string,
): Promise<boolean> {
  const db = await getSpaceDb(spaceId);

  if (userId) {
    await createAuditLog(db, {
      spaceId,
      docId: id,
      userId,
      event: "archive",
      details: { message: "Document archived" },
    });
  }

  await db
    .update(document)
    .set({ archived: true, updatedAt: new Date() })
    .where(eq(document.id, id));

  return true;
}

export async function restoreDocument(
  spaceId: string,
  id: string,
  userId?: string,
): Promise<boolean> {
  const db = await getSpaceDb(spaceId);

  if (userId) {
    await createAuditLog(db, {
      spaceId,
      docId: id,
      userId,
      event: "restore",
      details: { message: "Document restored" },
    });
  }

  await db
    .update(document)
    .set({ archived: false, updatedAt: new Date() })
    .where(eq(document.id, id));

  return true;
}

export async function deleteDocument(
  spaceId: string,
  id: string,
  userId?: string,
): Promise<boolean> {
  const db = await getSpaceDb(spaceId);

  if (userId) {
    await createAuditLog(db, {
      spaceId,
      docId: id,
      userId,
      event: "delete",
      details: { message: "Document deleted" },
    });
  }

  await db.delete(document).where(eq(document.id, id));

  return true;
}

/** Identity used for per-document ACL filtering; null = trusted system view. */
export interface AclViewer {
  userId: string;
  userGroups?: string[];
}

async function syncFileIndex(
  spaceId: string,
  db: Awaited<ReturnType<typeof getSpaceDb>>,
): Promise<void> {
  const storage = getFileStorage();
  const diskFiles = await storage.list(spaceId);
  if (diskFiles.length === 0) return;

  const indexed = new Set(
    (await db.select({ path: fileTable.path }).from(fileTable).all()).map((r) => r.path),
  );

  const toIndex = diskFiles.filter((f) => !indexed.has(f.key)).slice(0, 200);

  for (const { key, updatedAt } of toIndex) {
    const buf = await storage.read(spaceId, key);
    if (!buf) continue;
    const name = key.split("/").pop() ?? key;
    const extracted = extractFileTextFromBuffer(buf, name, undefined);
    const url = storage.url(spaceId, key);
    await db
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
  return Buffer.from(JSON.stringify({ t: updatedAt.getTime(), id })).toString(
    "base64url",
  );
}

export function decodeListCursor(cursor: string): { updatedAt: Date; id: string } | null {
  try {
    const { t, id } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof t !== "number" || typeof id !== "string") return null;
    return { updatedAt: new Date(t), id };
  } catch {
    return null;
  }
}

export async function listDocuments(
  spaceId: string,
  limit?: number,
  type?: string,
  viewer?: AclViewer | null,
  cursor?: string,
): Promise<{
  documents: DocumentWithProperties[];
  total: number;
  nextCursor: string | null;
}> {
  const db = await getSpaceDb(spaceId);
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
    const allDocs = await db
      .select(selectFields)
      .from(document)
      .where(baseCondition)
      .orderBy(desc(document.updatedAt), desc(document.id))
      .all();
    const readable = await filterReadableResources(
      spaceId,
      ResourceType.DOCUMENT,
      allDocs.map((d) => d.id),
      viewer.userId,
      viewer.userGroups,
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
    const rows = (await db
      .select(selectFields)
      .from(document)
      .where(seekCondition)
      .orderBy(desc(document.updatedAt), desc(document.id))
      .limit(fetchLimit)
      .all()) as DocRow[];

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
      ? await db.select().from(property).where(inArray(property.documentId, docIds)).all()
      : [];

  // Group properties by document ID
  const propsByDocId = new Map<string, Record<string, string>>();
  for (const prop of allProps) {
    if (!propsByDocId.has(prop.documentId)) {
      propsByDocId.set(prop.documentId, {});
    }
    propsByDocId.get(prop.documentId)![prop.key] = prop.value;
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

  if (!type || type === "file") {
    syncFileIndex(spaceId, db).catch(() => {});

    const standaloneFiles = await db
      .select()
      .from(fileTable)
      .where(sql`${fileTable.documentId} IS NULL`)
      .orderBy(desc(fileTable.updatedAt))
      .all();

    const fileResults = standaloneFiles.map(fileRowToDocument);

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
  spaceId: string,
  viewer?: AclViewer | null,
  options?: { limit?: number; offset?: number },
): Promise<{ documents: DocumentWithProperties[]; total: number }> {
  const db = await getSpaceDb(spaceId);

  let docs = await db
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
    .all();

  // Per-document ACL filtering, mirroring listDocuments. Space access alone
  // must not expose archived documents the caller cannot read.
  if (viewer) {
    const readable = await filterReadableResources(
      spaceId,
      ResourceType.DOCUMENT,
      docs.map((doc) => doc.id),
      viewer.userId,
      viewer.userGroups,
    );
    docs = docs.filter((doc) => readable.has(doc.id));
  }

  const allProps = await db.select().from(property).all();

  const propsByDocId = new Map<string, Record<string, string>>();
  for (const prop of allProps) {
    if (!propsByDocId.has(prop.documentId)) {
      propsByDocId.set(prop.documentId, {});
    }
    propsByDocId.get(prop.documentId)![prop.key] = prop.value;
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

  const total = results.length;
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  return { documents: results.slice(offset, offset + limit), total };
}

export async function updateDocumentProperty(
  spaceId: string,
  documentId: string,
  key: string,
  value: string,
  type?: string | null,
  userId?: string,
) {
  const db = await getSpaceDb(spaceId);
  const now = new Date();

  // Read existing value for audit log (indexed lookup, very fast)
  const existing = await db
    .select()
    .from(property)
    .where(and(eq(property.documentId, documentId), eq(property.key, key)))
    .get();

  const previousValue = existing?.value;

  const payload: { slug?: string } = {};

  if (existing) {
    const updateData: { value: string; updatedAt: Date; type?: string | null } = {
      value,
      updatedAt: now,
    };
    if (type !== undefined) updateData.type = type;
    await db.update(property).set(updateData).where(eq(property.id, existing.id));
  } else {
    await db.insert(property).values({
      id: createId("property"),
      documentId,
      key,
      value,
      type: type || null,
      createdAt: now,
      updatedAt: now,
    });
  }

  await createAuditLog(db, {
    spaceId,
    docId: documentId,
    userId,
    event: "property_update",
    details: {
      propertyKey: key,
      propertyType: type || undefined,
      previousValue,
      newValue: value,
    },
  });

  if (key === "title" && value) {
    const newSlug = await generateUniqueSlug(spaceId, value, documentId);
    await db
      .update(document)
      .set({ slug: newSlug, updatedAt: now })
      .where(eq(document.id, documentId));
    payload.slug = newSlug;
  } else {
    await db.update(document).set({ updatedAt: now }).where(eq(document.id, documentId));
  }

  updateDocumentEmbedding(spaceId, documentId).catch(() => {});
  const propertyChangeData = {
    kind: "document_property_changed",
    documentId,
    propertyKey: key,
    propertyType: type ?? existing?.type ?? null,
    previousValue: previousValue ?? null,
    value,
    slug: payload.slug ?? null,
  };
  const treeRelevantProperty = ["title", "category", "collection"].includes(key);

  sendSyncEvent(
    spaceId,
    {
      topic: realtimeTopics.properties,
      data: propertyChangeData,
    },
    {
      topic: realtimeTopics.document(documentId),
      data: propertyChangeData,
    },
    ...(treeRelevantProperty
      ? [
          {
            topic: realtimeTopics.documentTree,
            data: propertyChangeData,
          },
          {
            topic: realtimeTopics.categoryDocuments,
            data: propertyChangeData,
          },
        ]
      : []),
  );

  return payload;
}

export async function deleteDocumentProperty(
  spaceId: string,
  documentId: string,
  key: string,
  userId?: string,
): Promise<void> {
  const db = await getSpaceDb(spaceId);
  const now = new Date();

  // Get the property value before deletion for audit log
  const existing = await db
    .select()
    .from(property)
    .where(and(eq(property.documentId, documentId), eq(property.key, key)))
    .get();

  await db
    .delete(property)
    .where(and(eq(property.documentId, documentId), eq(property.key, key)));

  // Create audit log for property deletion
  if (existing) {
    await createAuditLog(db, {
      spaceId,
      docId: documentId,
      userId,
      event: "property_delete",
      details: {
        propertyKey: key,
        propertyType: existing.type || undefined,
        previousValue: existing.value,
      },
    });
  }

  // Update the document's updatedAt timestamp
  await db.update(document).set({ updatedAt: now }).where(eq(document.id, documentId));

  updateDocumentEmbedding(spaceId, documentId).catch(() => {});
  const propertyDeleteData = {
    kind: "document_property_deleted",
    documentId,
    propertyKey: key,
    propertyType: existing?.type ?? null,
    previousValue: existing?.value ?? null,
  };
  const treeRelevantProperty = ["title", "category", "collection"].includes(key);

  sendSyncEvent(
    spaceId,
    {
      topic: realtimeTopics.properties,
      data: propertyDeleteData,
    },
    {
      topic: realtimeTopics.document(documentId),
      data: propertyDeleteData,
    },
    ...(treeRelevantProperty
      ? [
          {
            topic: realtimeTopics.documentTree,
            data: propertyDeleteData,
          },
          {
            topic: realtimeTopics.categoryDocuments,
            data: propertyDeleteData,
          },
        ]
      : []),
  );
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
  db: BunSQLiteDatabase,
  documentId: string,
  userEmail: string,
): Promise<number> {
  const doc = await db
    .select({
      publishedRev: document.publishedRev,
    })
    .from(document)
    .where(eq(document.id, documentId))
    .get();

  if (!doc?.publishedRev) {
    return 0;
  }

  const cacheKey = `${documentId}:${doc.publishedRev}:${userEmail}`;

  const cached = mentionCountCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const rev = await db
    .select({
      snapshot: revision.snapshot,
    })
    .from(revision)
    .where(and(eq(revision.documentId, documentId), eq(revision.rev, doc.publishedRev)))
    .get();

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
    console.error("Failed to count mentions:", error);
    return 0;
  }
}

/**
 * List documents for multiple categories in one pass.
 * For each category slug, includes documents directly in that category plus all descendants.
 */
export async function listAllDocumentsByCategories(
  spaceId: string,
  categorySlugs: string[],
  userEmail?: string,
  viewer?: AclViewer | null,
): Promise<Record<string, DocumentWithProperties[]>> {
  const uniqueSlugs = Array.from(new Set(categorySlugs.filter(Boolean)));
  if (uniqueSlugs.length === 0) {
    return {};
  }

  const db = await getSpaceDb(spaceId);

  let docs = await db
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
    .orderBy(desc(document.updatedAt))
    .all();

  if (viewer) {
    const readable = await filterReadableResources(
      spaceId,
      ResourceType.DOCUMENT,
      docs.map((doc) => doc.id),
      viewer.userId,
      viewer.userGroups,
    );
    docs = docs.filter((doc) => readable.has(doc.id));
  }

  const allProps = await db.select().from(property).all();
  const propsByDocId = new Map<string, Record<string, string>>();

  for (const prop of allProps) {
    if (!propsByDocId.has(prop.documentId)) {
      propsByDocId.set(prop.documentId, {});
    }
    propsByDocId.get(prop.documentId)![prop.key] = prop.value;
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
    const category = doc.properties.category || doc.properties.collection;
    if (!category) continue;
    if (directDocIdsBySlug.has(category)) {
      directDocIdsBySlug.get(category)!.add(doc.id);
    }
  }

  const docIdsBySlug = new Map<string, Set<string>>();

  for (const slug of uniqueSlugs) {
    const collected = new Set<string>(directDocIdsBySlug.get(slug) || []);
    const stack = Array.from(collected);

    while (stack.length > 0) {
      const parentId = stack.pop()!;
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
        const count = await countMentionsForUser(db, docId, userEmail);
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
  spaceId: string,
  documentId: string,
  parentId: string | null,
): Promise<{
  documentId: string;
  previousParentId: string | null;
  parentId: string | null;
}> {
  const db = await getSpaceDb(spaceId);
  const now = new Date();
  const existing = await db
    .select({ parentId: document.parentId })
    .from(document)
    .where(eq(document.id, documentId))
    .get();

  if (parentId === documentId) {
    throw new Error("Cannot set parent: a child cant be a parent");
  }

  await db
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
  spaceId: string,
  parentId: string,
  viewer?: AclViewer | null,
): Promise<DocumentWithProperties[]> {
  const db = await getSpaceDb(spaceId);
  let docs = await db
    .select()
    .from(document)
    .where(and(eq(document.parentId, parentId), nonArchivedDocumentCondition))
    .all();

  // Per-document ACL filtering: a caller with access to the parent must not be
  // able to enumerate (or read the content of) children they cannot access.
  // A null viewer is a trusted system caller and sees everything.
  if (viewer) {
    const readable = await filterReadableResources(
      spaceId,
      ResourceType.DOCUMENT,
      docs.map((doc) => doc.id),
      viewer.userId,
      viewer.userGroups,
    );
    docs = docs.filter((doc) => readable.has(doc.id));
  }

  const childIds = docs.map((d) => d.id);
  const allProps =
    childIds.length > 0
      ? await db
          .select()
          .from(property)
          .where(inArray(property.documentId, childIds))
          .all()
      : [];

  const propsByDocId = new Map<string, Record<string, string>>();
  for (const prop of allProps) {
    if (!propsByDocId.has(prop.documentId)) propsByDocId.set(prop.documentId, {});
    propsByDocId.get(prop.documentId)![prop.key] = prop.value;
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

export async function searchDocuments(
  spaceId: string,
  userId: string | null,
  query: string,
  limit = 20,
  offset = 0,
  filters: PropertyFilter[] = [],
): Promise<{ results: SearchResult[]; total: number }> {
  const hasQuery = query.trim().length > 0;
  const hasFilters = filters.length > 0;

  // Need at least a query or filters to search
  if (!hasQuery && !hasFilters) {
    return { results: [], total: 0 };
  }

  const db = await getSpaceDb(spaceId);

  let docIds: string[] | null = null;
  if (userId !== null) {
    docIds = await listAccessibleResources(spaceId, userId, ResourceType.DOCUMENT);
    if (docIds.length === 0) {
      return { results: [], total: 0 };
    }
  }

  if (hasQuery) {
    const missingEmbeddings = await db
      .select({ id: document.id })
      .from(document)
      .where(
        sql`(search_embedding IS NULL OR search_text IS NULL)
          AND (type IS NULL OR type != 'canvas')
          AND ${nonArchivedDocumentCondition}`,
      )
      .all();

    for (const row of missingEmbeddings) {
      await updateDocumentEmbedding(spaceId, row.id);
    }
  }

  // Separate special filters from property filters
  const typeFilters = filters.filter((f) => f.key === "type");
  const dateFilters = filters.filter((f) => f.key === "_date");
  const propertyFilters = filters.filter((f) => f.key !== "type" && f.key !== "_date");

  // Helper to check if a document matches property filters
  const matchesFilters = (
    properties: Record<string, string>,
    docType: string | null,
  ): boolean => {
    for (const filter of typeFilters) {
      const normalizedType = docType || "document";
      if (filter.value === null) {
        continue; // "has type" is always true
      }
      if (normalizedType.toLowerCase() !== filter.value.toLowerCase()) {
        return false;
      }
    }
    for (const filter of propertyFilters) {
      const propValue = properties[filter.key];
      if (filter.value === null) {
        // Filter for "has property" - just check if key exists with any non-empty value
        if (propValue === undefined || propValue === "") {
          return false;
        }
      } else {
        // Filter for specific value (case-insensitive)
        if (
          propValue === undefined ||
          propValue.toLowerCase() !== filter.value.toLowerCase()
        ) {
          return false;
        }
      }
    }
    return true;
  };

  let allRawResults: {
    id: string;
    type: string | null;
    content: string;
    userId: string;
    parentId: string | null;
    createdAt: Date;
    updatedAt: Date;
    rank: number;
    snippet: string;
    // Set for standalone file-index entries (instead of a document row)
    file?: FileRow;
  }[];

  if (hasQuery) {
    const queryEmbedding = await embedText(query.trim());
    const candidates = await db.all<{
      id: string;
      slug: string;
      type: string | null;
      content: string;
      searchText: string | null;
      searchEmbedding: string | null;
      userId: string;
      parentId: string | null;
      currentRev: number;
      publishedRev: number | null;
      readonly: boolean;
      archived: boolean;
      createdAt: Date;
      updatedAt: Date;
    }>(sql`
      SELECT
        d.id,
        d.slug,
        d.type,
        d.content,
        d.search_text as searchText,
        d.search_embedding as searchEmbedding,
        d.created_by as userId,
        d.parent_id as parentId,
        d.current_rev as currentRev,
        d.published_rev as publishedRev,
        d.readonly as readonly,
        d.archived as archived,
        d.created_at as createdAt,
        d.updated_at as updatedAt
      FROM document d
      WHERE ${nonArchivedColumnCondition("d.archived")}
      AND d.search_embedding IS NOT NULL
    `);

    const ranked = candidates
      .map((candidate) => {
        const documentEmbedding = parseEmbedding(candidate.searchEmbedding);
        if (!documentEmbedding || !candidate.searchText) {
          return null;
        }

        const semanticScore = cosineSimilarity(queryEmbedding, documentEmbedding);
        const keywordScore = scoreKeywordOverlap(query, candidate.searchText);
        const combinedScore = semanticScore * 0.7 + keywordScore * 0.3;

        if (combinedScore < 0.12 && keywordScore === 0) {
          return null;
        }

        return {
          id: candidate.id,
          type: candidate.type,
          content: candidate.content,
          userId: candidate.userId,
          parentId: candidate.parentId,
          createdAt: candidate.createdAt,
          updatedAt: candidate.updatedAt,
          rank: Math.max(0, 1 - combinedScore),
          snippet: buildSearchSnippet(query, candidate.searchText),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((left, right) => left.rank - right.rank);

    allRawResults = ranked;
  } else {
    // Filter-only search (no text query) - get all non-archived documents
    allRawResults = await db.all<{
      id: string;
      type: string | null;
      content: string;
      userId: string;
      parentId: string | null;
      createdAt: Date;
      updatedAt: Date;
      rank: number;
      snippet: string;
    }>(sql`
      SELECT
        d.id,
        d.type,
        d.content,
        d.created_by as userId,
        d.parent_id as parentId,
        d.created_at as createdAt,
        d.updated_at as updatedAt,
        0 as rank,
        substr(d.content, 1, 200) as snippet
      FROM document d
      WHERE ${nonArchivedColumnCondition("d.archived")}
      ORDER BY d.updated_at DESC
    `);
  }

  // Merge file index entries (standalone + document-attached) so files are
  // findable directly, unless a type filter explicitly excludes files.
  const excludeFiles = typeFilters.some((f) => f.value !== null && f.value !== "file");
  if (!excludeFiles) {
    const indexedFiles = await db.select().from(fileTable).all();

    for (const f of indexedFiles) {
      let rank = 0;
      let snippet = "";
      if (hasQuery) {
        const fileSearchText = [f.originalName, f.extractedText]
          .filter(Boolean)
          .join("\n");
        const keywordScore = scoreKeywordOverlap(query, fileSearchText);
        if (keywordScore === 0) continue;
        rank = Math.max(0, 1 - keywordScore);
        snippet = buildSearchSnippet(query, fileSearchText);
      }
      allRawResults.push({
        id: f.path,
        type: "file",
        content: "",
        userId: "",
        parentId: null,
        createdAt: f.updatedAt ?? new Date(0),
        updatedAt: f.updatedAt ?? new Date(0),
        rank,
        snippet,
        file: f,
      });
    }

    if (hasQuery) allRawResults.sort((a, b) => a.rank - b.rank);
  }

  // Filter by accessible IDs (null docIds means job token — all docs accessible).
  // Standalone files (no parent doc) are accessible to anyone in the space;
  // document-attached files inherit their parent document's access.
  let accessibleResults =
    docIds === null
      ? allRawResults
      : allRawResults.filter((r) =>
          r.file
            ? r.file.documentId === null || docIds.includes(r.file.documentId)
            : docIds.includes(r.id),
        );

  // Apply date range filter
  if (dateFilters.length > 0 && accessibleResults.length > 0) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    accessibleResults = accessibleResults.filter((r) => {
      const ua = normalizeTimestamp(r.updatedAt as string | number | Date);
      for (const df of dateFilters) {
        switch (df.value) {
          case "today":
            if (ua < todayStart) return false;
            break;
          case "week":
            if (ua < weekStart || ua >= todayStart) return false;
            break;
          case "month":
            if (ua < monthStart || ua >= weekStart) return false;
            break;
          case "older":
            if (ua >= monthStart) return false;
            break;
        }
      }
      return true;
    });
  }

  // If we have property/type filters, apply them by loading properties for each document
  const hasPropertyOrTypeFilters = typeFilters.length > 0 || propertyFilters.length > 0;
  if (hasPropertyOrTypeFilters && accessibleResults.length > 0) {
    const filteredResults: typeof accessibleResults = [];

    for (const row of accessibleResults) {
      if (row.file) {
        if (matchesFilters(fileRowToDocument(row.file).properties, "file")) {
          filteredResults.push(row);
        }
        continue;
      }

      const props = await db
        .select()
        .from(property)
        .where(eq(property.documentId, row.id))
        .all();

      const properties: Record<string, string> = {};
      for (const prop of props) {
        properties[prop.key] = prop.value;
      }

      if (matchesFilters(properties, row.type)) {
        filteredResults.push(row);
      }
    }

    accessibleResults = filteredResults;
  }

  const total = accessibleResults.length;

  if (total === 0) {
    return { results: [], total: 0 };
  }

  // Apply pagination
  const rawResults = accessibleResults.slice(offset, offset + limit);

  const results: SearchResult[] = [];

  for (const row of rawResults) {
    if (row.file) {
      results.push({
        ...fileRowToDocument(row.file),
        rank: row.rank,
        snippet: row.snippet,
      });
      continue;
    }

    const props = await db
      .select()
      .from(property)
      .where(eq(property.documentId, row.id))
      .all();

    const properties: Record<string, string> = {};
    for (const prop of props) {
      properties[prop.key] = prop.value;
    }

    const doc = await db.select().from(document).where(eq(document.id, row.id)).get();

    results.push({
      id: row.id,
      slug: doc?.slug || "",
      type: doc?.type,
      content: row.content,
      currentRev: doc?.currentRev || 0,
      publishedRev: doc?.publishedRev || null,
      properties,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: row.userId,
      parentId: doc?.parentId || null,
      rank: row.rank,
      snippet: row.snippet,
      readonly: doc?.readonly || false,
      archived: doc?.archived || false,
    });
  }

  return { results, total };
}

export async function rebuildSearchIndex(spaceId: string): Promise<void> {
  const db = await getSpaceDb(spaceId);

  const docs = await db.select().from(document).all();

  for (const doc of docs) {
    if (doc.type === "canvas") {
      continue;
    }
    await updateDocumentEmbedding(spaceId, doc.id);
  }
}

export interface PropertyInfo {
  name: string;
  type: string | null;
  values: string[];
}

export async function getAllPropertiesWithValues(
  spaceId: string,
): Promise<PropertyInfo[]> {
  const db = await getSpaceDb(spaceId);

  const allProperties = await db.select().from(property).all();

  const propertyMap: Record<string, { type: string | null; values: Set<string> }> = {};

  for (const prop of allProperties) {
    if (!propertyMap[prop.key]) {
      propertyMap[prop.key] = {
        type: prop.type || null,
        values: new Set(),
      };
    }
    propertyMap[prop.key].values.add(prop.value);
    if (prop.type && !propertyMap[prop.key].type) {
      propertyMap[prop.key].type = prop.type;
    }
  }

  // Add document type as a virtual property
  const docTypes = await db
    .selectDistinct({ type: document.type })
    .from(document)
    .where(sql`${nonArchivedDocumentCondition}`)
    .all();

  const typeValues = docTypes
    .map((d) => d.type || "document")
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();

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
}

export async function getDocumentBreadcrumbs(
  spaceId: string,
  documentId: string,
): Promise<BreadcrumbItem[]> {
  const db = await getSpaceDb(spaceId);
  const breadcrumbs: BreadcrumbItem[] = [];

  let currentId: string | null = documentId;
  const visited = new Set<string>();

  while (currentId) {
    if (visited.has(currentId)) {
      break;
    }
    visited.add(currentId);

    const doc = await db
      .select({
        id: document.id,
        slug: document.slug,
        parentId: document.parentId,
      })
      .from(document)
      .where(eq(document.id, currentId))
      .get();

    if (!doc) {
      break;
    }

    const props = await db
      .select()
      .from(property)
      .where(and(eq(property.documentId, doc.id), eq(property.key, "title")))
      .get();

    breadcrumbs.unshift({
      id: doc.id,
      slug: doc.slug,
      title: props?.value || "Untitled",
    });

    currentId = doc.parentId;
  }

  return breadcrumbs;
}
