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
export const SEMANTIC_RANKING_WEIGHT = 0.4;

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
