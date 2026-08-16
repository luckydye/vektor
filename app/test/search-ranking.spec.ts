import { describe, expect, it } from "vitest";
import { getEmbeddingModel } from "#search/embeddingRuntime.ts";
import {
  MIN_SEMANTIC_SIMILARITY,
  rankSearchCandidates,
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

/**
 * The rule as a whole, over the stored shape of a document. Embeddings are unit
 * vectors and similarity is their dot product, so a two-dimensional vector can
 * be aimed at an exact similarity against the query.
 */
describe("ranking search candidates", () => {
  const queryEmbedding = [1, 0];

  const embeddingFor = (similarity: number) =>
    JSON.stringify([similarity, Math.sqrt(1 - similarity ** 2)]);

  const candidate = (
    id: string,
    title: string,
    content: string,
    similarity: number,
    searchEmbeddingModel: string = getEmbeddingModel(),
  ) => ({
    id,
    title,
    content,
    searchText: `${title}\n\n${content}`,
    searchEmbedding: embeddingFor(similarity),
    searchEmbeddingModel,
  });

  const ids = (candidates: Parameters<typeof rankSearchCandidates>[2], query: string) =>
    rankSearchCandidates(query, queryEmbedding, candidates).map(
      (result) => (result.candidate as { id: string }).id,
    );

  // The repro from #128: a query no document contains, against a corpus whose
  // similarities all sit in the model's usual band.
  const fruits = [
    candidate("apple", "Apple", "red fruit orchard", 0.63),
    candidate("banana", "Banana", "yellow tropical", 0.62),
    candidate("cherry", "Cherry", "small stone pit", 0.6),
  ];

  it("returns nothing when the query matches no document", () => {
    expect(ids(fruits, "qwertyuiop")).toEqual([]);
  });

  it("returns only the document the query names", () => {
    const standout = [
      candidate("apple", "Apple", "red fruit orchard", 0.66),
      candidate("banana", "Banana", "yellow tropical", 0.63),
      candidate("cherry", "Cherry", "small stone pit", 0.85),
    ];

    expect(ids(standout, "cherry")).toEqual(["cherry"]);
  });

  it("keeps lexical matches when the embedding runtime is unavailable", () => {
    const ranked = rankSearchCandidates("tropical", null, fruits);

    expect(ranked.map((result) => result.candidate.id)).toEqual(["banana"]);
    expect(ranked[0].snippet).toContain("<mark>tropical</mark>");
  });

  it("ignores embeddings written by a different model", () => {
    const stale = [
      candidate("apple", "Apple", "red fruit orchard", 0.99, "some-older-model"),
      ...fruits.slice(1),
    ];

    expect(ids(stale, "qwertyuiop")).toEqual([]);
  });

  it("ranks a lexical match above a semantic-only one", () => {
    const mixed = [
      candidate("apple", "Apple", "red fruit orchard", 0.92),
      candidate("cherry", "Cherry", "small stone pit", 0.6),
    ];

    expect(ids(mixed, "cherry")).toEqual(["cherry", "apple"]);
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
