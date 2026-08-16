/**
 * Scoring and presenting search hits: keyword overlap, semantic similarity,
 * and the snippet shown under each result. Pure functions over text.
 */

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
/**
 * How far above the corpus baseline a similarity has to sit before it counts as
 * a match rather than as the model's usual background noise.
 */
export const MIN_SEMANTIC_MARGIN = 0.1;
export const SEMANTIC_RANKING_WEIGHT = 0.4;

/**
 * The similarity a document must reach, for this query, before similarity alone
 * makes it a result.
 *
 * bge similarities sit on a high and query-dependent baseline: two unrelated
 * short English texts routinely score between 0.6 and 0.8, and a query that is
 * not a word at all still embeds into that same band. A fixed floor therefore
 * admits documents that have nothing to do with the query, and does so
 * erratically — one nonsense term clears it for two documents, the next for
 * none. The median similarity across the corpus measures what "unrelated" looks
 * like for this particular query; a genuine match has to beat that by a margin.
 * That is what separates `cherry` (one document stands out from its neighbours)
 * from `qwertyuiop` (every document sits at the baseline together).
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

/**
 * The part of a similarity that says something about the query rather than
 * about the model's baseline. Zero means "no semantic match": it neither makes
 * a document a result on its own nor moves its rank.
 */
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
