import { eq, inArray, sql } from "drizzle-orm";
import { ResourceType } from "#acl/permissions.ts";
import { listAccessibleResources } from "#acl/store.ts";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { document, file as fileTable, property } from "#db/schema/space.ts";
import {
  type DocumentProperties,
  parseStoredPropertyValue,
  propertyValueToText,
  readDocumentProperty,
  toDocumentPropertiesByDocument,
} from "#documents/properties.ts";
import { appLogger } from "#observability/logger.ts";
import {
  buildDocumentSearchText,
  embedText,
  parseEmbedding,
  serializeEmbedding,
} from "#search/embedding.ts";
import { getEmbeddingModel } from "#search/embeddingRuntime.ts";
import {
  buildSearchSnippet,
  cosineSimilarity,
  MIN_SEMANTIC_SIMILARITY,
  SEMANTIC_RANKING_WEIGHT,
  scoreKeywordOverlap,
  scoreToRank,
} from "#search/ranking.ts";

// ---------------------------------------------------------------------------
// SQL helpers shared with documents.ts
// ---------------------------------------------------------------------------

export const nonArchivedDocumentCondition = sql`
  (
    ${document.archived} = 0
    OR ${document.archived} = '0'
    OR ${document.archived} = '0.0'
    OR ${document.archived} IS NULL
    OR ${document.archived} = FALSE
  )
`;

export function nonArchivedColumnCondition(column: string) {
  return sql.raw(
    `(${column} = 0 OR ${column} = '0' OR ${column} = '0.0' OR ${column} IS NULL OR ${column} = FALSE)`,
  );
}

// ---------------------------------------------------------------------------
// Shared document types
// ---------------------------------------------------------------------------

export interface DocumentWithProperties {
  id: string;
  slug: string;
  type?: string | null;
  content?: string;
  currentRev: number;
  publishedRev: number | null;
  properties: DocumentProperties;
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

export interface PropertyFilter {
  key: string;
  value: string | null;
}

/**
 * Raw `sql` selections bypass drizzle's column codec, so an
 * `integer(mode: "timestamp")` column arrives as the stored unix seconds rather
 * than a `Date` — and the driver hands those back as numeric strings
 * (`"1786455693.0"`), the same loose typing `nonArchivedColumnCondition` guards.
 * Convert at the query boundary; everything downstream works in `Date`.
 */
function storedSecondsToDate(value: string | number): Date {
  const seconds = Number(value);
  // A legacy row holding a date string rather than a number would go NaN here.
  return Number.isNaN(seconds) ? new Date(value) : new Date(seconds * 1000);
}

export type FileRow = typeof fileTable.$inferSelect;

export function fileRowToDocument(f: FileRow): DocumentWithProperties {
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

// ---------------------------------------------------------------------------
// Document embedding
// ---------------------------------------------------------------------------

export async function updateDocumentEmbedding(
  s: SpaceStore,
  documentId: string,
): Promise<void> {
  // Check the type without loading `content` — canvases (which can be tens of
  // MB) are never embedded, so pulling the content column here just to bail out
  // wasted memory on every canvas save.
  const meta = await one(
    s.db
      .select({ type: document.type })
      .from(document)
      .where(eq(document.id, documentId)),
  );

  if (!meta) {
    return;
  }

  if (meta.type === "canvas") {
    await s.db
      .update(document)
      .set({
        searchText: null,
        searchEmbedding: null,
        searchEmbeddingModel: null,
        searchUpdatedAt: null,
      })
      .where(eq(document.id, documentId));
    return;
  }

  const doc = await one(s.db.select().from(document).where(eq(document.id, documentId)));

  if (!doc) {
    return;
  }

  const props = await many(
    s.db.select().from(property).where(eq(property.documentId, documentId)),
  );

  const attachedFiles = await many(
    s.db.select().from(fileTable).where(eq(fileTable.documentId, documentId)),
  );
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
  const searchEmbeddingModel = getEmbeddingModel();

  await s.db
    .update(document)
    .set({
      searchText,
      searchEmbedding,
      searchEmbeddingModel,
      searchUpdatedAt: new Date(),
    })
    .where(eq(document.id, documentId));
}

/** Refresh search data without turning a successful document write into a failure. */
export async function updateDocumentEmbeddingBestEffort(
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

export async function rebuildSearchIndex(s: SpaceStore): Promise<void> {
  const docs = await many(s.db.select().from(document));

  for (const doc of docs) {
    if (doc.type === "canvas") {
      continue;
    }
    await updateDocumentEmbedding(s, doc.id);
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// Cursor encodes the index into the deterministically-ordered in-memory
// result set (relevance-ranked, then filtered) of the last returned result.
export function encodeSearchCursor(index: number): string {
  return Buffer.from(JSON.stringify({ i: index })).toString("base64url");
}

export function decodeSearchCursor(cursor: string): { index: number } | null {
  try {
    const { i } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof i !== "number") return null;
    return { index: i };
  } catch {
    return null;
  }
}

/**
 * How many ids one `IN (…)` carries. Search filters run over every accessible
 * result, which can be the whole space, and SQLite binds one parameter per id.
 */
const ID_BATCH = 500;

function batches<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += ID_BATCH) {
    result.push(items.slice(index, index + ID_BATCH));
  }
  return result;
}

/** Every document's properties in one read, grouped by document. */
async function readProperties(
  s: SpaceStore,
  documentIds: string[],
): Promise<Map<string, DocumentProperties>> {
  const allRows: (typeof property.$inferSelect)[] = [];

  for (const ids of batches(documentIds)) {
    allRows.push(
      ...(await many(
        s.db.select().from(property).where(inArray(property.documentId, ids)),
      )),
    );
  }

  return toDocumentPropertiesByDocument(allRows);
}

/** The document rows behind a page of results, keyed by id. */
async function readDocuments(
  s: SpaceStore,
  documentIds: string[],
): Promise<Map<string, typeof document.$inferSelect>> {
  const byId = new Map<string, typeof document.$inferSelect>();

  for (const ids of batches(documentIds)) {
    const rows = await many(
      s.db.select().from(document).where(inArray(document.id, ids)),
    );
    for (const row of rows) byId.set(row.id, row);
  }

  return byId;
}

export async function searchDocuments(
  s: SpaceStore,
  userId: string | null,
  query: string,
  limit = 20,
  cursor?: string,
  filters: PropertyFilter[] = [],
): Promise<{ results: SearchResult[]; nextCursor: string | null }> {
  const hasQuery = query.trim().length > 0;
  const hasFilters = filters.length > 0;

  if (!hasQuery && !hasFilters) {
    return { results: [], nextCursor: null };
  }

  let docIds: string[] | null = null;
  if (userId !== null) {
    docIds = await listAccessibleResources(s.spaceId, userId, ResourceType.DOCUMENT);
    if (docIds !== null && docIds.length === 0) {
      return { results: [], nextCursor: null };
    }
  }

  if (hasQuery) {
    const embeddingModel = getEmbeddingModel();
    try {
      const missingEmbeddings = await many(
        s.db
          .select({ id: document.id })
          .from(document)
          .where(
            sql`(search_embedding IS NULL OR search_text IS NULL OR search_embedding_model IS NULL OR search_embedding_model != ${embeddingModel} OR search_updated_at IS NULL OR search_updated_at < updated_at)
            AND (type IS NULL OR type != 'canvas')
            AND ${nonArchivedDocumentCondition}`,
          ),
      );

      for (const row of missingEmbeddings) {
        await updateDocumentEmbedding(s, row.id);
      }
    } catch {
      // Embedding service unavailable — skip catch-up indexing, fall back to keyword search
    }
  }

  const typeFilters = filters.filter((f) => f.key === "type");
  const dateFilters = filters.filter((f) => f.key === "_date");
  const propertyFilters = filters.filter((f) => f.key !== "type" && f.key !== "_date");

  const matchesFilters = (
    properties: DocumentProperties,
    docType: string | null,
  ): boolean => {
    for (const filter of typeFilters) {
      const normalizedType = docType || "document";
      if (filter.value === null) {
        continue;
      }
      if (normalizedType.toLowerCase() !== filter.value.toLowerCase()) {
        return false;
      }
    }
    for (const filter of propertyFilters) {
      // Own keys only: `filter.key` comes straight from the request, so a filter
      // on `toString` would otherwise read `Object.prototype.toString` and throw
      // `value.toLowerCase is not a function` below.
      const propValue = readDocumentProperty(properties, filter.key);
      if (filter.value === null) {
        if (
          propValue === undefined ||
          propValue === "" ||
          (Array.isArray(propValue) && propValue.length === 0)
        ) {
          return false;
        }
      } else {
        if (propValue === undefined) return false;
        const values = Array.isArray(propValue) ? propValue : [propValue];
        const expected = filter.value.toLowerCase();
        if (!values.some((value) => value.toLowerCase() === expected)) {
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
    file?: FileRow;
  }[];

  if (hasQuery) {
    const embeddingModel = getEmbeddingModel();
    let queryEmbedding: number[] | null = null;
    try {
      queryEmbedding = await embedText(query.trim());
    } catch {
      // Embedding service unavailable — fall back to keyword-only search
    }

    const candidates = await s.db.all<{
      id: string;
      slug: string;
      type: string | null;
      content: string;
      title: string | null;
      searchText: string | null;
      searchEmbedding: string | null;
      searchEmbeddingModel: string | null;
      userId: string;
      parentId: string | null;
      currentRev: number;
      publishedRev: number | null;
      readonly: boolean;
      archived: boolean;
      createdAt: string | number;
      updatedAt: string | number;
    }>(sql`
      SELECT
        d.id,
        d.slug,
        d.type,
        d.content,
        title.value as title,
        d.search_text as searchText,
        d.search_embedding as searchEmbedding,
        d.search_embedding_model as searchEmbeddingModel,
        d.created_by as userId,
        d.parent_id as parentId,
        d.current_rev as currentRev,
        d.published_rev as publishedRev,
        d.readonly as readonly,
        d.archived as archived,
        d.created_at as createdAt,
        d.updated_at as updatedAt
      FROM document d
      LEFT JOIN property title ON title.document_id = d.id AND title.key = 'title'
      WHERE ${nonArchivedColumnCondition("d.archived")}
    `);

    const ranked = candidates
      .map((candidate) => {
        // Read the title directly as well as from the cached search text. The
        // latter is updated asynchronously after a title edit and may also be
        // unavailable when the embedding runtime cannot index a document.
        const title = candidate.title
          ? propertyValueToText(parseStoredPropertyValue(candidate.title))
          : "";
        const textForScoring = [title, candidate.searchText ?? candidate.content]
          .filter(Boolean)
          .join("\n\n");
        const keywordScore = scoreKeywordOverlap(query, textForScoring);

        let semanticScore: number | null = null;
        if (
          queryEmbedding !== null &&
          candidate.searchEmbeddingModel === embeddingModel
        ) {
          const documentEmbedding = parseEmbedding(candidate.searchEmbedding);
          if (documentEmbedding) {
            semanticScore = cosineSimilarity(queryEmbedding, documentEmbedding);
          }
        }

        // BGE similarities have a relatively high baseline even for unrelated
        // text. Only admit semantic-only results when the model expresses a
        // meaningful match; lexical matches remain available regardless.
        if (
          keywordScore === 0 &&
          (semanticScore === null || semanticScore < MIN_SEMANTIC_SIMILARITY)
        ) {
          return null;
        }

        // Exact and prefix matches should outrank broader semantic similarity.
        // Keep the raw score monotonic and convert it to rank reciprocally so
        // strong lexical matches do not collapse into identical rank-zero ties.
        const combinedScore =
          keywordScore + (semanticScore ?? 0) * SEMANTIC_RANKING_WEIGHT;

        return {
          id: candidate.id,
          type: candidate.type,
          content: candidate.content,
          userId: candidate.userId,
          parentId: candidate.parentId,
          createdAt: storedSecondsToDate(candidate.createdAt),
          updatedAt: storedSecondsToDate(candidate.updatedAt),
          rank: scoreToRank(combinedScore),
          snippet: buildSearchSnippet(query, textForScoring),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((left, right) => left.rank - right.rank);

    allRawResults = ranked;
  } else {
    const rows = await s.db.all<{
      id: string;
      type: string | null;
      content: string;
      userId: string;
      parentId: string | null;
      createdAt: string | number;
      updatedAt: string | number;
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

    allRawResults = rows.map((row) => ({
      ...row,
      createdAt: storedSecondsToDate(row.createdAt),
      updatedAt: storedSecondsToDate(row.updatedAt),
    }));
  }

  const excludeFiles = typeFilters.some((f) => f.value !== null && f.value !== "file");
  if (!excludeFiles) {
    const indexedFiles = await many(s.db.select().from(fileTable));

    for (const f of indexedFiles) {
      let rank = 0;
      let snippet = "";
      if (hasQuery) {
        const fileSearchText = [f.originalName, f.extractedText]
          .filter(Boolean)
          .join("\n");
        const keywordScore = scoreKeywordOverlap(query, fileSearchText);
        if (keywordScore === 0) continue;
        rank = scoreToRank(keywordScore);
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

  let accessibleResults =
    docIds === null
      ? allRawResults
      : allRawResults.filter((r) =>
          r.file
            ? r.file.documentId === null || docIds.includes(r.file.documentId)
            : docIds.includes(r.id),
        );

  if (dateFilters.length > 0 && accessibleResults.length > 0) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    accessibleResults = accessibleResults.filter((r) => {
      const ua = r.updatedAt;
      for (const df of dateFilters) {
        if (df.value?.includes("/")) {
          const [startStr, endStr] = df.value.split("/");
          const rangeStart = startStr ? new Date(startStr) : null;
          const rangeEnd = endStr ? new Date(endStr) : null;
          if (rangeStart && ua < rangeStart) return false;
          if (rangeEnd) {
            const dayAfterEnd = new Date(rangeEnd);
            dayAfterEnd.setDate(dayAfterEnd.getDate() + 1);
            if (ua >= dayAfterEnd) return false;
          }
          continue;
        }
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

  const hasPropertyOrTypeFilters = typeFilters.length > 0 || propertyFilters.length > 0;
  if (hasPropertyOrTypeFilters && accessibleResults.length > 0) {
    const filteredResults: typeof accessibleResults = [];
    const propertiesByDocument = await readProperties(
      s,
      accessibleResults.filter((row) => !row.file).map((row) => row.id),
    );

    for (const row of accessibleResults) {
      if (row.file) {
        if (matchesFilters(fileRowToDocument(row.file).properties, "file")) {
          filteredResults.push(row);
        }
        continue;
      }

      if (matchesFilters(propertiesByDocument.get(row.id) ?? {}, row.type)) {
        filteredResults.push(row);
      }
    }

    accessibleResults = filteredResults;
  }

  const total = accessibleResults.length;

  if (total === 0) {
    return { results: [], nextCursor: null };
  }

  const pos = cursor ? decodeSearchCursor(cursor) : null;
  const startIndex = pos?.index ?? 0;
  const rawResults = accessibleResults.slice(startIndex, startIndex + limit);
  const nextCursor =
    startIndex + limit < total ? encodeSearchCursor(startIndex + limit) : null;

  const results: SearchResult[] = [];
  const pageDocumentIds = rawResults.filter((row) => !row.file).map((row) => row.id);
  const [propertiesByDocument, documentsById] = await Promise.all([
    readProperties(s, pageDocumentIds),
    readDocuments(s, pageDocumentIds),
  ]);

  for (const row of rawResults) {
    if (row.file) {
      results.push({
        ...fileRowToDocument(row.file),
        rank: row.rank,
        snippet: row.snippet,
      });
      continue;
    }

    const properties = propertiesByDocument.get(row.id) ?? {};
    const doc = documentsById.get(row.id);

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

  return { results, nextCursor };
}
