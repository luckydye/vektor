import { describe, expect, it } from "vitest";
import {
  formatFilterTerm,
  mergeFilters,
  parseSearchQuery,
  termAtCaret,
} from "#search/query.ts";

describe("parseSearchQuery", () => {
  it("keeps a plain query as text", () => {
    const parsed = parseSearchQuery("release notes");
    expect(parsed.text).toBe("release notes");
    expect(parsed.filters).toEqual([]);
  });

  it("lifts key:value terms out of the text", () => {
    const parsed = parseSearchQuery("status:open release notes");
    expect(parsed.text).toBe("release notes");
    expect(parsed.filters).toEqual([{ key: "status", value: "open" }]);
  });

  it("reads a quoted value as one value", () => {
    const parsed = parseSearchQuery('owner:"Ada Lovelace" notes');
    expect(parsed.filters).toEqual([{ key: "owner", value: "Ada Lovelace" }]);
    expect(parsed.text).toBe("notes");
  });

  it("maps the type and date keys onto the internal filters", () => {
    expect(parseSearchQuery("type:canvas").filters).toEqual([
      { key: "_type", value: "canvas" },
    ]);
    expect(parseSearchQuery("modified:2026-01-01/2026-02-01").filters).toEqual([
      { key: "_date", value: "2026-01-01/2026-02-01" },
    ]);
  });

  it("reads * as any value", () => {
    expect(parseSearchQuery("status:*").filters).toEqual([
      { key: "status", value: null },
    ]);
  });

  it("applies nothing while a term is still being typed", () => {
    const parsed = parseSearchQuery("status:");
    expect(parsed.filters).toEqual([]);
    expect(parsed.segments.map((s) => s.kind)).toEqual(["key", "separator"]);
  });

  it("leaves a URL and a term that does not start a word in the text", () => {
    expect(parseSearchQuery("https://example.com").filters).toEqual([]);
    expect(parseSearchQuery("https://example.com").text).toBe("https://example.com");
    expect(parseSearchQuery("(status:open").filters).toEqual([]);
  });

  it("covers the whole input with segments, in order", () => {
    const raw = "status:open release";
    const parsed = parseSearchQuery(raw);
    expect(parsed.segments.map((s) => s.text).join("")).toBe(raw);
  });
});

describe("mergeFilters", () => {
  it("drops duplicates regardless of key case", () => {
    expect(
      mergeFilters(
        [{ key: "Status", value: "open" }],
        [{ key: "status", value: "open" }],
      ),
    ).toEqual([{ key: "Status", value: "open" }]);
  });

  it("keeps different values of the same key", () => {
    expect(
      mergeFilters([{ key: "status", value: "open" }], [{ key: "status", value: null }]),
    ).toHaveLength(2);
  });
});

describe("termAtCaret", () => {
  it("reads a plain word as a key still being typed", () => {
    expect(termAtCaret("stat", 4)).toEqual({
      start: 0,
      end: 4,
      key: null,
      typed: "stat",
    });
  });

  it("splits the term the caret is in at its colon", () => {
    expect(termAtCaret("release status:op", 17)).toEqual({
      start: 8,
      end: 17,
      key: "status",
      typed: "op",
    });
  });

  it("unquotes the value being typed", () => {
    expect(termAtCaret('owner:"Ada', 10)?.typed).toBe("Ada");
  });

  it("has nothing to complete in whitespace", () => {
    expect(termAtCaret("a  b", 2)).toBeNull();
  });
});

describe("formatFilterTerm", () => {
  it("quotes a value only when it has to", () => {
    expect(formatFilterTerm("status", "open")).toBe("status:open");
    expect(formatFilterTerm("owner", "Ada Lovelace")).toBe('owner:"Ada Lovelace"');
  });
});
