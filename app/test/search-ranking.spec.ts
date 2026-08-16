import { describe, expect, it } from "vitest";
import {
  MIN_SEMANTIC_SIMILARITY,
  scoreKeywordOverlap,
  semanticMatchThreshold,
  semanticRelevance,
} from "#search/ranking.ts";

/**
 * These guard the rule that decides whether a document the query does not match
 * lexically is still a result. bge similarities never approach zero for
 * unrelated text, so the numbers below are the shapes that actually come out of
 * the model: a tight band when nothing matches, one clear outlier when
 * something does.
 */
describe("semantic match threshold", () => {
  it("keeps the absolute floor when there is nothing to measure", () => {
    expect(semanticMatchThreshold([])).toBe(MIN_SEMANTIC_SIMILARITY);
  });

  it("never drops below the absolute floor", () => {
    expect(semanticMatchThreshold([0.1, 0.12, 0.09])).toBe(MIN_SEMANTIC_SIMILARITY);
  });

  it("rejects every document when the corpus sits at one baseline", () => {
    // A term present in no document: all three score alike, none stands out.
    const similarities = [0.63, 0.62, 0.6];
    const threshold = semanticMatchThreshold(similarities);

    for (const similarity of similarities) {
      expect(semanticRelevance(similarity, threshold)).toBe(0);
    }
  });

  it("admits only the document that stands out from the baseline", () => {
    const [match, ...rest] = [0.85, 0.66, 0.63];
    const threshold = semanticMatchThreshold([match, ...rest]);

    expect(semanticRelevance(match, threshold)).toBeGreaterThan(0);
    for (const similarity of rest) {
      expect(semanticRelevance(similarity, threshold)).toBe(0);
    }
  });

  it("takes the baseline from the median, not from the outliers", () => {
    // Two strong matches out of many must not pull the baseline up with them.
    const noise = Array.from({ length: 20 }, () => 0.65);
    const threshold = semanticMatchThreshold([0.9, 0.88, ...noise]);

    expect(threshold).toBeCloseTo(0.75, 10);
  });

  it("averages the two middle similarities for an even-sized corpus", () => {
    expect(semanticMatchThreshold([0.7, 0.9, 0.8, 0.62])).toBeCloseTo(0.85, 10);
  });

  it("reports no relevance without an embedding", () => {
    expect(semanticRelevance(null, MIN_SEMANTIC_SIMILARITY)).toBe(0);
  });
});

describe("keyword overlap", () => {
  it("scores nothing for a term the text does not contain", () => {
    expect(scoreKeywordOverlap("qwertyuiop", "red fruit orchard")).toBe(0);
    expect(scoreKeywordOverlap("cherry", "yellow tropical")).toBe(0);
  });

  it("scores exact and prefix matches", () => {
    expect(scoreKeywordOverlap("cherry", "Cherry small stone pit")).toBeGreaterThan(0);
    expect(scoreKeywordOverlap("trop", "yellow tropical")).toBeGreaterThan(0);
  });
});
