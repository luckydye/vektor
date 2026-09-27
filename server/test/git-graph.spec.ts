/**
 * Laying commits out as a graph.
 *
 * The rules are easy to state and easy to get subtly wrong, so they are pinned
 * here rather than judged by eye in a screenshot: a straight history stays in
 * one lane, a branch takes a second, a merge brings it back, and a line that
 * merely passes a row is still drawn.
 *
 * Run with:
 *   bunx --bun vitest run test/git-graph.spec.ts
 */

import { describe, expect, it } from "vitest";
import { type GraphCommit, layoutGraph } from "#git/graph.ts";

/** `git log` order: newest first, every parent after its children. */
function history(...entries: [string, ...string[]][]): GraphCommit[] {
  return entries.map(([oid, ...parents]) => ({ oid, parents }));
}

describe("a straight history", () => {
  const rows = layoutGraph(history(["c", "b"], ["b", "a"], ["a"]));

  it("keeps every commit in the first lane", () => {
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
  });

  it("is one lane wide throughout", () => {
    expect(rows.map((row) => row.width)).toEqual([1, 1, 1]);
  });

  it("draws a line down to each parent", () => {
    expect(rows[0].edges).toEqual([{ from: 0, to: 0 }]);
  });

  it("draws nothing below the root", () => {
    expect(rows[2].edges).toEqual([]);
  });
});

describe("a merge", () => {
  // m merges side branch `s` back into `b`; both descend from `a`.
  const rows = layoutGraph(history(["m", "b", "s"], ["b", "a"], ["s", "a"], ["a"]));

  it("puts the merge commit in the first lane", () => {
    expect(rows[0].lane).toBe(0);
  });

  it("opens a second lane for the other parent", () => {
    expect(rows[0].width).toBe(2);
    expect(rows[0].edges).toContainEqual({ from: 0, to: 1 });
  });

  it("keeps each parent in its own lane", () => {
    expect(rows[1].lane).toBe(0);
    expect(rows[2].lane).toBe(1);
  });

  it("draws the untouched lane past the row that does not own it", () => {
    // While `b` is drawn, the lane holding `s` is still waiting and must not
    // silently disappear for a row.
    expect(rows[1].edges).toContainEqual({ from: 1, to: 1 });
  });

  it("converges both lanes onto the shared ancestor", () => {
    expect(rows[3].lane).toBe(0);
    expect(rows[3].edges).toContainEqual({ from: 1, to: 0 });
    expect(rows[3].width).toBe(1);
  });
});

describe("a commit with several children", () => {
  it("is one dot, not one per child", () => {
    // Both `x` and `y` have `a` as their parent, so two lanes wait on it.
    const rows = layoutGraph(history(["x", "a"], ["y", "a"], ["a"]));
    const shared = rows[2];
    expect(shared.lane).toBe(0);
    expect(rows.filter((row) => row.lane === shared.lane)).toHaveLength(2);
    expect(shared.edges).toContainEqual({ from: 1, to: 0 });
  });
});

describe("a truncated log", () => {
  it("does not draw an edge to a parent it never received", () => {
    // The last page of a log ends on commits whose parents were not fetched.
    const rows = layoutGraph(history(["c", "b"]));
    expect(rows[0].edges).toEqual([{ from: 0, to: 0 }]);
    expect(rows[0].width).toBe(1);
  });
});
