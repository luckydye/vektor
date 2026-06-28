import { and, eq, sql } from "drizzle-orm";
import { config } from "../config.ts";
import { normalizeTimestamp } from "../utils/utils.ts";
import { listAccessibleResources, ResourceType } from "./acl.ts";
import { getSpaceDb } from "./db.ts";
import { document, file as fileTable, property } from "./schema/space.ts";

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

export interface PropertyFilter {
  key: string;
  value: string | null;
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
// Embedding utilities
// ---------------------------------------------------------------------------

const LOCAL_EMBEDDING_DIMENSIONS = 384;

function stripMarkup(input: string): string {
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(input: string): string {
  return stripMarkup(input).toLowerCase();
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index++) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}

function localEmbedding(text: string): number[] {
  const normalized = normalizeText(text);
  const vector = new Array<number>(LOCAL_EMBEDDING_DIMENSIONS).fill(0);
  const words = normalized.match(/[a-z0-9]+/g) ?? [];

  for (const word of words) {
    const wordIndex = hashToken(`w:${word}`) % LOCAL_EMBEDDING_DIMENSIONS;
    vector[wordIndex] += 3;

    if (word.length >= 3) {
      for (let index = 0; index <= word.length - 3; index++) {
        const trigram = word.slice(index, index + 3);
        const trigramIndex = hashToken(`g:${trigram}`) % LOCAL_EMBEDDING_DIMENSIONS;
        vector[trigramIndex] += 1;
      }
    }
  }

  return normalizeVector(vector);
}

async function remoteEmbedding(text: string): Promise<number[]> {
  const runtimeConfig = config();
  const apiKey = runtimeConfig.SEARCH_EMBEDDINGS_API_KEY;
  const model = runtimeConfig.SEARCH_EMBEDDINGS_MODEL || "text-embedding-3-small";
  const baseUrl =
    runtimeConfig.SEARCH_EMBEDDINGS_BASE_URL || "https://openrouter.ai/api/v1";

  if (!apiKey) {
    throw new Error("SEARCH_EMBEDDINGS_API_KEY is not configured");
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Embedding request failed with status ${response.status}`);
  }

  const data = await response.json();
  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error("Embedding response did not include a vector");
  }
  return normalizeVector(embedding.map((value: unknown) => Number(value) || 0));
}

export function buildDocumentSearchText(
  content: string,
  properties: Record<string, string>,
  fileText?: string,
): string {
  const title = properties.title?.trim() ?? "";
  const propertyText = Object.entries(properties)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  return [title, title, propertyText, content, fileText].filter(Boolean).join("\n\n");
}

export async function embedText(text: string): Promise<number[]> {
  const provider = config().SEARCH_EMBEDDINGS_PROVIDER || "local";

  if (provider === "remote") {
    return remoteEmbedding(text);
  }

  return localEmbedding(text);
}

export function parseEmbedding(value: string | null | undefined): number[] | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => Number(item) || 0) : null;
  } catch {
    return null;
  }
}

export function serializeEmbedding(embedding: number[]): string {
  return JSON.stringify(embedding);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let total = 0;
  for (let index = 0; index < left.length; index++) {
    total += left[index] * right[index];
  }
  return total;
}

export function extractQueryTerms(query: string): string[] {
  const phrases = [...query.matchAll(/"([^"]+)"/g)].map((match) =>
    normalizeText(match[1]).trim(),
  );
  const unquoted = query.replace(/"[^"]+"/g, " ");
  const words = (normalizeText(unquoted).match(/[a-z0-9*]+/g) ?? []).map((term) =>
    term.replace(/\*+$/g, ""),
  );

  return [...new Set([...phrases, ...words].filter((term) => term.length > 0))];
}

export function scoreKeywordOverlap(query: string, text: string): number {
  const haystack = normalizeText(text);
  const terms = extractQueryTerms(query);
  if (terms.length === 0) {
    return 0;
  }

  let score = 0;
  for (const term of terms) {
    const exactIndex = haystack.indexOf(term);
    if (exactIndex >= 0) {
      score += term.includes(" ") ? 1.5 : 1;
      if (exactIndex < 80) {
        score += 0.5;
      }
      if (exactIndex === 0) {
        score += 0.5;
      }
      continue;
    }

    if (!term.includes(" ")) {
      const words = haystack.match(/[a-z0-9]+/g) ?? [];
      const prefixIndex = words.findIndex((word) => word.startsWith(term));
      if (prefixIndex >= 0) {
        score += 0.8;
        if (prefixIndex < 8) {
          score += 0.3;
        }
      }
    }
  }

  return score / terms.length;
}

function escapeHtml(input: string): string {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function buildSearchSnippet(query: string, text: string): string {
  const normalizedText = stripMarkup(text);
  if (!normalizedText) {
    return "";
  }

  const terms = extractQueryTerms(query);
  const lowerText = normalizedText.toLowerCase();
  let startIndex = 0;

  for (const term of terms) {
    const index = lowerText.indexOf(term.toLowerCase());
    if (index >= 0) {
      startIndex = Math.max(0, index - 60);
      break;
    }
  }

  const excerpt = normalizedText.slice(startIndex, startIndex + 220).trim();
  let highlighted = escapeHtml(excerpt);

  for (const term of [...terms].sort((left, right) => right.length - left.length)) {
    if (!term) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    highlighted = highlighted.replace(
      new RegExp(escaped, "gi"),
      (match) => `<mark>${match}</mark>`,
    );
  }

  return highlighted;
}

// ---------------------------------------------------------------------------
// Document embedding
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

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

  if (!hasQuery && !hasFilters) {
    return { results: [], total: 0 };
  }

  const db = await getSpaceDb(spaceId);

  let docIds: string[] | null = null;
  if (userId !== null) {
    docIds = await listAccessibleResources(spaceId, userId, ResourceType.DOCUMENT);
    if (docIds !== null && docIds.length === 0) {
      return { results: [], total: 0 };
    }
  }

  if (hasQuery) {
    try {
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
    } catch {
      // Embedding service unavailable — skip catch-up indexing, fall back to keyword search
    }
  }

  const typeFilters = filters.filter((f) => f.key === "type");
  const dateFilters = filters.filter((f) => f.key === "_date");
  const propertyFilters = filters.filter((f) => f.key !== "type" && f.key !== "_date");

  const matchesFilters = (
    properties: Record<string, string>,
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
      const propValue = properties[filter.key];
      if (filter.value === null) {
        if (propValue === undefined || propValue === "") {
          return false;
        }
      } else {
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
    file?: FileRow;
  }[];

  if (hasQuery) {
    let queryEmbedding: number[] | null = null;
    try {
      queryEmbedding = await embedText(query.trim());
    } catch {
      // Embedding service unavailable — fall back to keyword-only search
    }

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
    `);

    const ranked = candidates
      .map((candidate) => {
        const textForScoring = candidate.searchText ?? candidate.content;
        const keywordScore = scoreKeywordOverlap(query, textForScoring);

        let combinedScore: number;
        if (queryEmbedding !== null) {
          const documentEmbedding = parseEmbedding(candidate.searchEmbedding);
          if (documentEmbedding) {
            const semanticScore = cosineSimilarity(queryEmbedding, documentEmbedding);
            combinedScore = semanticScore * 0.7 + keywordScore * 0.3;
          } else {
            combinedScore = keywordScore;
          }
        } else {
          combinedScore = keywordScore;
        }

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
          snippet: buildSearchSnippet(query, textForScoring),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((left, right) => left.rank - right.rank);

    allRawResults = ranked;
  } else {
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
