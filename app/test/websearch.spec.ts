import { describe, expect, it } from "bun:test";
import { extractSearchResults, formatSearchResults } from "#agent/commands/websearch.ts";

describe("websearch result extraction", () => {
  it("reads the default SearXNG schema (results[]/title/url/content)", () => {
    const results = extractSearchResults({
      results: [
        { title: "First", url: "https://a.example", content: "alpha snippet" },
        { title: "Second", url: "https://b.example", content: "beta snippet" },
      ],
    });
    expect(results).toEqual([
      { title: "First", url: "https://a.example", snippet: "alpha snippet" },
      { title: "Second", url: "https://b.example", snippet: "beta snippet" },
    ]);
  });

  it("falls back to Brave's web.results[] with description", () => {
    const results = extractSearchResults({
      web: {
        results: [{ title: "Brave", url: "https://brave.example", description: "desc" }],
      },
    });
    expect(results).toEqual([
      { title: "Brave", url: "https://brave.example", snippet: "desc" },
    ]);
  });

  it("falls back to Google's items[] with link and snippet", () => {
    const results = extractSearchResults({
      items: [{ title: "Google", link: "https://g.example", snippet: "goog snippet" }],
    });
    expect(results).toEqual([
      { title: "Google", url: "https://g.example", snippet: "goog snippet" },
    ]);
  });

  it("accepts a bare array response", () => {
    const results = extractSearchResults([
      { name: "Named", href: "https://n.example", text: "text snippet" },
    ]);
    expect(results).toEqual([
      { title: "Named", url: "https://n.example", snippet: "text snippet" },
    ]);
  });

  it("uses the url as a title fallback and tolerates missing snippets", () => {
    const results = extractSearchResults({
      results: [{ url: "https://only-url.example" }],
    });
    expect(results).toEqual([
      { title: "https://only-url.example", url: "https://only-url.example", snippet: "" },
    ]);
  });

  it("skips entries with no usable fields and non-object responses", () => {
    expect(extractSearchResults({ results: [{}, null, 42] })).toEqual([]);
    expect(extractSearchResults(null)).toEqual([]);
    expect(extractSearchResults("nope")).toEqual([]);
  });
});

describe("websearch result formatting", () => {
  it("numbers results and includes url and snippet lines", () => {
    const output = formatSearchResults(
      "query",
      [{ title: "Title", url: "https://x.example", snippet: "a snippet" }],
      8,
    );
    expect(output).toBe("1. Title\n   https://x.example\n   a snippet");
  });

  it("respects the limit", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      title: `T${i}`,
      url: `https://x${i}.example`,
      snippet: "",
    }));
    const output = formatSearchResults("query", many, 2);
    expect(output).toContain("1. T0");
    expect(output).toContain("2. T1");
    expect(output).not.toContain("3. T2");
  });

  it("reports when there are no results", () => {
    expect(formatSearchResults("nothing", [], 8)).toBe('No results for "nothing".');
  });
});
