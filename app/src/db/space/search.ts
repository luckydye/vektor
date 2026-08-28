/**
 * The database side of search: the rows, the index columns behind them, and
 * filtering and paging the results. What matches and how it ranks is decided in
 * `#search/ranking.ts`, what goes into the index in `#search/indexing.ts`.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { document, file as fileTable, property } from "#db/schema/space.ts";
import {
  DATE_FILTER_KEY,
  DOCUMENT_TYPE_FILTER_KEY,
  type DocumentProperties,
  parseStoredPropertyValue,
  propertyValueToText,
  readDocumentProperty,
  toDocumentPropertiesByDocument,
} from "#documents/properties.ts";
import { embedSearchQuery } from "#search/embedding.ts";
import { rankKeywordMatch, rankSearchCandidates } from "#search/ranking.ts";
import type { DocumentWithProperties } from "./documents.ts";

// ---------------------------------------------------------------------------
// SQL helpers shared with documents.ts
// ---------------------------------------------------------------------------

/** `archived` is loosely typed in stored data: `0`, `'0'`, `'0.0'`, NULL, FALSE. */
export const nonArchivedDocumentCondition = sql`
  (
    ${document.archived} = 0
    OR ${document.archived} = '0'
    OR ${document.archived} = '0.0'
    OR ${document.archived} IS NULL
    OR ${document.archived} = FALSE
  )
`;

/** The same, for a raw `sql` selection with no column object. */
export function nonArchivedColumnCondition(column: string) {
  return sql.raw(
    `(${column} = 0 OR ${column} = '0' OR ${column} = '0.0' OR ${column} IS NULL OR ${column} = FALSE)`,
  );
}

// ---------------------------------------------------------------------------
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
    fileSize: f.size ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Search index rows
// ---------------------------------------------------------------------------

export interface DocumentIndexSource {
  content: string;
  properties: (typeof property.$inferSelect)[];
  files: FileRow[];
}

export interface DocumentIndex {
  searchText: string;
  searchEmbedding: string;
  searchEmbeddingModel: string;
  searchUpdatedAt: Date;
}

/**
 * The type on its own, so the indexer can decide whether to load the document's
 * stored body before `readDocumentIndexSource` reads its content column.
 */
export async function readDocumentType(
  s: SpaceStore,
  documentId: string,
): Promise<{ type: string | null } | null> {
  return (
    (await one(
      s.db
        .select({ type: document.type })
        .from(document)
        .where(eq(document.id, documentId)),
    )) ?? null
  );
}

/** Everything a document is indexed from: its content, properties and files. */
export async function readDocumentIndexSource(
  s: SpaceStore,
  documentId: string,
  options: { includeContent: boolean },
): Promise<DocumentIndexSource | null> {
  const doc = await one(
    s.db
      .select({
        content: options.includeContent ? document.content : sql<string>`''`,
      })
      .from(document)
      .where(eq(document.id, documentId)),
  );

  if (!doc) {
    return null;
  }

  return {
    content: doc.content,
    properties: await many(
      s.db.select().from(property).where(eq(property.documentId, documentId)),
    ),
    files: await many(
      s.db.select().from(fileTable).where(eq(fileTable.documentId, documentId)),
    ),
  };
}

export async function writeDocumentIndex(
  s: SpaceStore,
  documentId: string,
  index: DocumentIndex,
): Promise<void> {
  await s.db.update(document).set(index).where(eq(document.id, documentId));
}

/** Every document can carry an index of its title, properties, and attached files. */
export async function readIndexableDocumentIds(s: SpaceStore): Promise<string[]> {
  const rows = await many(s.db.select({ id: document.id }).from(document));

  return rows.map((row) => row.id);
}

/** Documents whose index is missing, from another model, or out of date. */
export async function readStaleIndexDocumentIds(
  s: SpaceStore,
  embeddingModel: string,
): Promise<string[]> {
  const rows = await many(
    s.db
      .select({ id: document.id })
      .from(document)
      .where(
        and(
          sql`(search_embedding IS NULL OR search_text IS NULL OR search_embedding_model IS NULL OR search_embedding_model != ${embeddingModel} OR search_updated_at IS NULL OR search_updated_at < updated_at)`,
          nonArchivedDocumentCondition,
        ),
      ),
  );

  return rows.map((row) => row.id);
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
 * How much of a document's text ranking scores. Bodies are uncapped, and both
 * scoring and snippetting are full passes over the text, so an editor could
 * otherwise make one search read and scan tens of megabytes per document. A
 * snippet comes from the first match, which for a real query is near the top.
 */
const SCORING_TEXT_LIMIT = 8000;

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

export interface SearchDocumentsOptions {
  limit?: number;
  cursor?: string;
  filters?: PropertyFilter[];
  /** Passed to `#search/ranking.ts`: the bar a match has to clear. */
  strict?: boolean;
  /**
   * The query vector, for a caller searching several spaces off one embedding.
   * Undefined embeds the query here; null searches by keyword alone.
   */
  queryEmbedding?: number[] | null;
}

/**
 * Documents matching `query` and `filters`, ranked and paged. `docIds` is the
 * caller's readable set, or null for an unrestricted view. Reads the index as
 * it stands; callers refresh it first through `#search/indexing.ts`.
 */
export async function searchDocuments(
  s: SpaceStore,
  docIds: string[] | null,
  query: string,
  options: SearchDocumentsOptions = {},
): Promise<{ results: SearchResult[]; nextCursor: string | null }> {
  const { limit = 20, cursor, filters = [], strict = false } = options;
  const hasQuery = query.trim().length > 0;
  const hasFilters = filters.length > 0;

  if ((!hasQuery && !hasFilters) || docIds?.length === 0) {
    return { results: [], nextCursor: null };
  }

  const typeFilters = filters.filter((f) => f.key === DOCUMENT_TYPE_FILTER_KEY);
  const dateFilters = filters.filter((f) => f.key === DATE_FILTER_KEY);
  const propertyFilters = filters.filter(
    (f) => f.key !== DOCUMENT_TYPE_FILTER_KEY && f.key !== DATE_FILTER_KEY,
  );

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
    userId: string;
    parentId: string | null;
    createdAt: Date;
    updatedAt: Date;
    rank: number;
    snippet: string;
    file?: FileRow;
  }[];

  if (hasQuery) {
    // The vector and the rows are independent; embedding is native compute.
    const [candidates, queryEmbedding] = await Promise.all([
      s.db.all<{
        id: string;
        slug: string;
        type: string | null;
        title: string | null;
        scoringText: string;
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
        title.value as title,
        substr(coalesce(d.search_text, d.content), 1, ${SCORING_TEXT_LIMIT}) as scoringText,
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
    `),
      options.queryEmbedding === undefined
        ? embedSearchQuery(query)
        : options.queryEmbedding,
    ]);

    const ranked = await rankSearchCandidates(
      query,
      queryEmbedding,
      candidates.map((candidate) => ({
        ...candidate,
        title: candidate.title
          ? propertyValueToText(parseStoredPropertyValue(candidate.title))
          : "",
      })),
      { strict },
    );

    allRawResults = ranked.map(({ candidate, rank, snippet }) => ({
      id: candidate.id,
      type: candidate.type,
      userId: candidate.userId,
      parentId: candidate.parentId,
      createdAt: storedSecondsToDate(candidate.createdAt),
      updatedAt: storedSecondsToDate(candidate.updatedAt),
      rank,
      snippet,
    }));
  } else {
    const rows = await s.db.all<{
      id: string;
      type: string | null;
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
    // Extracted text is as uncapped as a document body, and only ranking reads it.
    const indexedFiles = await many(
      s.db
        .select({
          path: fileTable.path,
          documentId: fileTable.documentId,
          originalName: fileTable.originalName,
          mimeType: fileTable.mimeType,
          size: fileTable.size,
          width: fileTable.width,
          height: fileTable.height,
          url: fileTable.url,
          updatedAt: fileTable.updatedAt,
          extractedText: sql<
            string | null
          >`substr(${fileTable.extractedText}, 1, ${SCORING_TEXT_LIMIT})`,
        })
        .from(fileTable),
    );

    for (const f of indexedFiles) {
      let rank = 0;
      let snippet = "";
      if (hasQuery) {
        const match = rankKeywordMatch(
          query,
          [f.originalName, f.extractedText].filter(Boolean).join("\n"),
          { strict },
        );
        if (!match) continue;
        rank = match.rank;
        snippet = match.snippet;
      }
      allRawResults.push({
        id: f.path,
        type: "file",
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
      // A result is a pointer plus its snippet: bodies run to megabytes, and
      // shipping the page's would put that in the response.
      content: "",
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
