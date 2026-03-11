import { and, desc, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/libsql";
import {
  grantPermission,
  listAccessibleResources,
  Permission,
  ResourceType,
} from "./acl.ts";
import { createAuditLog } from "./auditLogs.ts";
import { sendSyncEvent } from "./ws.ts";
import { getSpaceDb } from "./db.ts";
import { createRevision } from "./revisions.ts";
import { document, property, revision } from "./schema/space.ts";
import { slugify } from "../utils/utils.ts";
import { triggerWebhooks } from "./webhooks.ts";
import { extractMentionsFromHtml } from "./mentions.ts";
import { decompressHtml } from "./revisions.ts";
import { readOnlyDocumentTypes } from "../utils/documentTypes.ts";
import { realtimeTopics } from "../utils/realtime.ts";
import {
  buildDocumentSearchText,
  buildSearchSnippet,
  cosineSimilarity,
  embedText,
  parseEmbedding,
  scoreKeywordOverlap,
  serializeEmbedding,
} from "./searchEmbeddings.ts";
import { createId } from "./ids.ts";

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

async function updateDocumentEmbedding(spaceId: string, documentId: string): Promise<void> {
  const db = await getSpaceDb(spaceId);

  const doc = await db.select().from(document).where(eq(document.id, documentId)).get();

  if (!doc) {
    return;
  }

  const props = await db
    .select()
    .from(property)
    .where(eq(property.documentId, documentId))
    .all();

  const properties = Object.fromEntries(props.map((item) => [item.key, item.value]));
  const searchText = buildDocumentSearchText(doc.content, properties);
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
}

export type SearchResult = DocumentWithProperties & {
  rank: number;
  snippet: string;
};

// Property filter for advanced search
// Use value: null to filter for documents that have the property (any value)
// Use value: string to filter for documents with that specific property value
export interface PropertyFilter {
  key: string;
  value: string | null;
}

export async function createDocument(
  spaceId: string,
  createdBy: string,
  slug: string,
  content: string,
  initialProperties?: Record<string, string>,
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

  for (const [key, value] of Object.entries(properties)) {
    await db.insert(property).values({
      id: createId("property"),
      documentId: id,
      key,
      value,
      createdAt: now,
      updatedAt: now,
    });
  }

  await grantPermission(spaceId, ResourceType.DOCUMENT, id, createdBy, Permission.OWNER);

  await updateDocumentEmbedding(spaceId, id);

  await createRevision(spaceId, id, content, createdBy, "Initial revision");

  await createAuditLog(await getSpaceDb(spaceId), {
    spaceId,
    docId: id,
    revisionId: 1,
    userId: createdBy,
    event: "create",
    details: { message: "Document created" },
  });

  return {
    id,
    slug: uniqueSlug,
    type: type || null,
    content,
    currentRev: 1,
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

  await triggerWebhooks(db, {
    event: "document.archived",
    spaceId,
    documentId: id,
    timestamp: new Date().toISOString(),
  });

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

  await triggerWebhooks(db, {
    event: "document.restored",
    spaceId,
    documentId: id,
    timestamp: new Date().toISOString(),
  });

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

  await triggerWebhooks(db, {
    event: "document.deleted",
    spaceId,
    documentId: id,
    timestamp: new Date().toISOString(),
  });

  return true;
}

export async function listDocuments(
  spaceId: string,
  limit?: number,
  offset?: number,
): Promise<{ documents: DocumentWithProperties[]; total: number }> {
  const db = await getSpaceDb(spaceId);

  // Get total count first
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(document)
    .where(eq(document.archived, false))
    .get();

  const total = countResult?.count || 0;

  // Build query
  const baseQuery = db
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
    .where(eq(document.archived, false))
    .orderBy(desc(document.updatedAt));

  // Apply pagination if provided
  let docs: Array<{
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
  }>;
  if (limit !== undefined && offset !== undefined) {
    docs = await baseQuery.limit(limit).offset(offset).all();
  } else if (limit !== undefined) {
    docs = await baseQuery.limit(limit).all();
  } else if (offset !== undefined) {
    docs = await baseQuery.offset(offset).all();
  } else {
    docs = await baseQuery.all();
  }

  // Fetch all properties in one query instead of N queries
  const allProps = await db.select().from(property).all();

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

  return { documents: results, total };
}

export async function listArchivedDocuments(
  spaceId: string,
): Promise<DocumentWithProperties[]> {
  const db = await getSpaceDb(spaceId);

  const docs = await db
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
    .where(eq(document.archived, true))
    .all();

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

  return results;
}

export async function getDocumentCountsByCategory(
  spaceId: string,
): Promise<{
  counts: Record<string, number>;
  firstDocs: Record<string, { id: string; slug: string }>;
}> {
  const db = await getSpaceDb(spaceId);

  // Get all document IDs and slugs
  const docs = await db
    .select({
      id: document.id,
      slug: document.slug,
    })
    .from(document)
    .where(eq(document.archived, false))
    .all();

  if (docs.length === 0) {
    return { counts: {}, firstDocs: {} };
  }

  // Get category/collection properties for all documents
  const categoryProps = await db
    .select({
      documentId: property.documentId,
      key: property.key,
      value: property.value,
    })
    .from(property)
    .where(sql`${property.key} IN ('category', 'collection')`)
    .all();

  // Build counts and first docs per category
  const counts: Record<string, number> = {};
  const firstDocs: Record<string, { id: string; slug: string }> = {};
  const docMap = new Map(docs.map((d) => [d.id, d]));

  for (const prop of categoryProps) {
    const category = prop.value;
    counts[category] = (counts[category] || 0) + 1;

    if (!firstDocs[category]) {
      const doc = docMap.get(prop.documentId);
      if (doc) {
        firstDocs[category] = { id: doc.id, slug: doc.slug };
      }
    }
  }

  return { counts, firstDocs };
}

export async function countDocuments(spaceId: string): Promise<number> {
  const db = await getSpaceDb(spaceId);

  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(document)
    .where(eq(document.archived, false))
    .get();

  return result?.count || 0;
}

export async function listDraftDocuments(
  spaceId: string,
  limit?: number,
  offset?: number,
): Promise<{ documents: DocumentWithProperties[]; total: number }> {
  const db = await getSpaceDb(spaceId);

  // Get all documents
  const docs = await db
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
    .where(eq(document.archived, false))
    .orderBy(desc(document.updatedAt))
    .all();

  if (docs.length === 0) return { documents: [], total: 0 };

  // Fetch all properties in one query
  const allProps = await db.select().from(property).all();

  // Group properties by document ID
  const propsByDocId = new Map<string, Record<string, string>>();
  for (const prop of allProps) {
    if (!propsByDocId.has(prop.documentId)) {
      propsByDocId.set(prop.documentId, {});
    }
    propsByDocId.get(prop.documentId)![prop.key] = prop.value;
  }

  // Filter and build results for drafts only (no category/collection)
  const results: DocumentWithProperties[] = [];
  for (const doc of docs) {
    const properties = propsByDocId.get(doc.id) || {};

    // Only include documents without category or collection
    if (!properties.category && !properties.collection) {
      results.push({
        id: doc.id,
        slug: doc.slug,
        type: doc.type,
        content: "", // Empty content for list view
        currentRev: doc.currentRev,
        publishedRev: doc.publishedRev,
        properties,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        createdBy: doc.createdBy,
        parentId: doc.parentId || null,
        readonly: doc.readonly,
        archived: doc.archived,
      });
    }
  }

  // Apply pagination if provided
  const total = results.length;
  if (limit !== undefined && offset !== undefined) {
    const paginatedResults = results.slice(offset, offset + limit);
    return { documents: paginatedResults, total };
  } else if (limit !== undefined) {
    const paginatedResults = results.slice(0, limit);
    return { documents: paginatedResults, total };
  } else if (offset !== undefined) {
    const paginatedResults = results.slice(offset);
    return { documents: paginatedResults, total };
  }

  return { documents: results, total };
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

  const existing = await db
    .select()
    .from(property)
    .where(and(eq(property.documentId, documentId), eq(property.key, key)))
    .get();

  const previousValue = existing?.value;

  if (existing) {
    const updateData: { value: string; updatedAt: Date; type?: string | null } = {
      value,
      updatedAt: now,
    };
    if (type !== undefined) {
      updateData.type = type;
    }
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

  // Create audit log for property update
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

  const payload: { slug?: string } = {};

  // If updating the title, also update the document slug
  if (key === "title" && value) {
    const newSlug = await generateUniqueSlug(spaceId, value, documentId);
    await db
      .update(document)
      .set({ slug: newSlug, updatedAt: now })
      .where(eq(document.id, documentId));
    payload.slug = newSlug;
  } else {
    // Update the document's updatedAt timestamp
    await db.update(document).set({ updatedAt: now }).where(eq(document.id, documentId));
  }

  await updateDocumentEmbedding(spaceId, documentId);
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

  await updateDocumentEmbedding(spaceId, documentId);
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
 * Clear entire mention count cache
 */
export function clearMentionCache() {
  mentionCountCache.clear();
}

/**
 * Get mention cache statistics
 */
export function getMentionCacheStats() {
  return {
    size: mentionCountCache.size,
    keys: Array.from(mentionCountCache.keys()),
  };
}

/**
 * Count mentions of a specific user email in a document's published revision
 * Results are cached in memory to avoid recomputing on every request
 */
async function countMentionsForUser(
  db: ReturnType<typeof drizzle>,
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
): Promise<Record<string, DocumentWithProperties[]>> {
  const uniqueSlugs = Array.from(new Set(categorySlugs.filter(Boolean)));
  if (uniqueSlugs.length === 0) {
    return {};
  }

  const db = await getSpaceDb(spaceId);

  const docs = await db
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
    .where(eq(document.archived, false))
    .orderBy(desc(document.updatedAt))
    .all();

  const allProps = await db.select().from(property).all();
  const propsByDocId = new Map<string, Record<string, string>>();

  for (const prop of allProps) {
    if (!propsByDocId.has(prop.documentId)) {
      propsByDocId.set(prop.documentId, {});
    }
    propsByDocId.get(prop.documentId)![prop.key] = prop.value;
  }

  const typeFilteredResults: DocumentWithProperties[] = docs
    .map((doc) => ({
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
    }))
    .filter((doc) => doc.type === "document");

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
): Promise<{ documentId: string; previousParentId: string | null; parentId: string | null }> {
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
): Promise<DocumentWithProperties[]> {
  const db = await getSpaceDb(spaceId);
  const docs = await db
    .select()
    .from(document)
    .where(and(eq(document.parentId, parentId), eq(document.archived, false)))
    .all();

  const results: DocumentWithProperties[] = [];

  for (const doc of docs) {
    const props = await db
      .select()
      .from(property)
      .where(eq(property.documentId, doc.id))
      .all();

    const properties: Record<string, string> = {};
    for (const prop of props) {
      properties[prop.key] = prop.value;
    }

    results.push({
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
    });
  }

  return results;
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
          AND (archived = 0 OR archived = '0' OR archived = '0.0' OR archived IS NULL OR archived = FALSE)
          AND (type = 'document' OR type IS NULL)`,
      )
      .all();

    for (const row of missingEmbeddings) {
      await updateDocumentEmbedding(spaceId, row.id);
    }
  }

  // Helper to check if a document matches property filters
  const matchesFilters = (properties: Record<string, string>): boolean => {
    for (const filter of filters) {
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
    content: string;
    userId: string;
    parentId: string | null;
    createdAt: Date;
    updatedAt: Date;
    rank: number;
    snippet: string;
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
      WHERE (d.archived = 0 OR d.archived = '0' OR d.archived = '0.0' OR d.archived IS NULL OR d.archived = FALSE)
      AND (d.type = 'document' OR d.type IS NULL)
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

    if (ranked.length === 0 && !hasFilters) {
      return { results: [], total: 0 };
    }
    allRawResults = ranked;
  } else {
    // Filter-only search (no text query) - get all non-archived documents
    allRawResults = await db.all<{
      id: string;
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
        d.content,
        d.created_by as userId,
        d.parent_id as parentId,
        d.created_at as createdAt,
        d.updated_at as updatedAt,
        0 as rank,
        substr(d.content, 1, 200) as snippet
      FROM document d
      WHERE (d.archived = 0 OR d.archived = '0' OR d.archived = '0.0' OR d.archived IS NULL OR d.archived = FALSE)
      AND (d.type = 'document' OR d.type IS NULL)
      ORDER BY d.updated_at DESC
    `);
  }

  // Filter by accessible IDs (null docIds means job token — all docs accessible)
  let accessibleResults =
    docIds === null ? allRawResults : allRawResults.filter((r) => docIds!.includes(r.id));

  // If we have filters, apply them by loading properties for each document
  if (hasFilters && accessibleResults.length > 0) {
    const filteredResults: typeof accessibleResults = [];

    for (const row of accessibleResults) {
      const props = await db
        .select()
        .from(property)
        .where(eq(property.documentId, row.id))
        .all();

      const properties: Record<string, string> = {};
      for (const prop of props) {
        properties[prop.key] = prop.value;
      }

      if (matchesFilters(properties)) {
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

  const result: PropertyInfo[] = [];
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
