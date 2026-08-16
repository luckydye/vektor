/**
 * Scoring and presenting search hits: keyword overlap, semantic similarity,
 * and the snippet shown under each result. Pure functions over text and stored
 * embeddings the caller has already read.
 */

import { parseEmbedding } from "#search/embedding.ts";
import { getEmbeddingModel } from "#search/embeddingRuntime.ts";
import { normalizeText, stripMarkup } from "#search/text.ts";
import { escapeHtml } from "#utils/html.ts";

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

/** Below this cosine similarity a semantic match is treated as noise. */
export const MIN_SEMANTIC_SIMILARITY = 0.6;
/** How far a similarity must sit above the corpus baseline to count as a match. */
export const MIN_SEMANTIC_MARGIN = 0.1;
export const SEMANTIC_RANKING_WEIGHT = 0.4;

/**
 * The similarity a document must reach before similarity alone makes it a
 * result. bge scores unrelated short texts at 0.6-0.8, and a nonsense query
 * embeds into that same band, so a fixed floor admits anything. The median
 * measures that baseline per query; a match has to beat it by a margin.
 */
export function semanticMatchThreshold(similarities: number[]): number {
  if (similarities.length === 0) {
    return MIN_SEMANTIC_SIMILARITY;
  }

  const sorted = [...similarities].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;

  return Math.max(MIN_SEMANTIC_SIMILARITY, median + MIN_SEMANTIC_MARGIN);
}

/** The part of a similarity above the baseline. Zero means "no semantic match". */
export function semanticRelevance(similarity: number | null, threshold: number): number {
  return similarity === null ? 0 : Math.max(0, similarity - threshold);
}

export function scoreToRank(score: number): number {
  return 1 / (1 + Math.max(0, score));
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

export interface SearchCandidate {
  /** Title text, already decoded from its stored property value. */
  title: string;
  searchText: string | null;
  content: string;
  searchEmbedding: string | null;
  searchEmbeddingModel: string | null;
}

export interface RankedCandidate<T> {
  candidate: T;
  rank: number;
  snippet: string;
}

/** The title is scored separately: `searchText` lags a title edit, and is
 * missing entirely while the embedding runtime cannot index a document. */
function textForScoring(candidate: SearchCandidate): string {
  return [candidate.title, candidate.searchText ?? candidate.content]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The documents a query matches, best first: a lexical match, or a similarity
 * above the corpus baseline. `queryEmbedding` is null when the embedding
 * runtime is unavailable, leaving keyword matching on its own.
 */
export function rankSearchCandidates<T extends SearchCandidate>(
  query: string,
  queryEmbedding: number[] | null,
  candidates: T[],
): RankedCandidate<T>[] {
  const embeddingModel = getEmbeddingModel();

  const scored = candidates.map((candidate) => {
    let similarity: number | null = null;
    if (queryEmbedding !== null && candidate.searchEmbeddingModel === embeddingModel) {
      const documentEmbedding = parseEmbedding(candidate.searchEmbedding);
      if (documentEmbedding) {
        similarity = cosineSimilarity(queryEmbedding, documentEmbedding);
      }
    }

    const text = textForScoring(candidate);
    return {
      candidate,
      text,
      keywordScore: scoreKeywordOverlap(query, text),
      similarity,
    };
  });

  // A property of the corpus, so it needs every candidate scored first.
  const threshold = semanticMatchThreshold(
    scored
      .map((item) => item.similarity)
      .filter((similarity): similarity is number => similarity !== null),
  );

  const ranked: RankedCandidate<T>[] = [];

  for (const { candidate, text, keywordScore, similarity } of scored) {
    const semanticBoost = semanticRelevance(similarity, threshold);
    if (keywordScore === 0 && semanticBoost === 0) {
      continue;
    }

    // Reciprocal rank keeps exact and prefix matches ahead of broad similarity
    // without collapsing strong lexical matches into rank-zero ties.
    ranked.push({
      candidate,
      rank: scoreToRank(keywordScore + semanticBoost * SEMANTIC_RANKING_WEIGHT),
      snippet: buildSearchSnippet(query, text),
    });
  }

  return ranked.sort((left, right) => left.rank - right.rank);
}

/** Rank for text with no embedding — files. Null when the query does not match. */
export function rankKeywordMatch(
  query: string,
  text: string,
): { rank: number; snippet: string } | null {
  const keywordScore = scoreKeywordOverlap(query, text);
  if (keywordScore === 0) {
    return null;
  }

  return { rank: scoreToRank(keywordScore), snippet: buildSearchSnippet(query, text) };
}
