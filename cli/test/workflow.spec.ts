import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/workflow.ts";

describe("workflow cli", () => {
  it("parses document id and flags", () => {
    const options = parseArgs([
      "abc123",
      "--input", "file=https://example.com/data.xlsx",
      "--input", "title=My Run",
      "--json",
      "--url", "http://localhost:3000",
      "--space", "my-space",
      "--token", "tok123",
    ]);
    expect(options.documentId).toBe("abc123");
    expect(options.inputs).toEqual({ file: "https://example.com/data.xlsx", title: "My Run" });
    expect(options.json).toBe(true);
    expect(options.url).toBe("http://localhost:3000");
    expect(options.spaceId).toBe("my-space");
    expect(options.token).toBe("tok123");
  });

  it("reads host and space from env when flags are omitted", () => {
    const prev = { host: process.env.WIKI_HOST, space: process.env.WIKI_SPACE_ID };
    process.env.WIKI_HOST = "http://wiki.local";
    process.env.WIKI_SPACE_ID = "env-space";
    try {
      const options = parseArgs(["docid"]);
      expect(options.url).toBe("http://wiki.local");
      expect(options.spaceId).toBe("env-space");
      expect(options.inputs).toEqual({});
      expect(options.json).toBe(false);
    } finally {
      if (prev.host === undefined) delete process.env.WIKI_HOST;
      else process.env.WIKI_HOST = prev.host;
      if (prev.space === undefined) delete process.env.WIKI_SPACE_ID;
      else process.env.WIKI_SPACE_ID = prev.space;
    }
  });

  it("throws when document id is missing", () => {
    expect(() => parseArgs([])).toThrow();
  });

  it("throws when --url and WIKI_HOST are both absent", () => {
    const prev = process.env.WIKI_HOST;
    delete process.env.WIKI_HOST;
    try {
      expect(() => parseArgs(["docid", "--space", "s"])).toThrow("--url is required");
    } finally {
      if (prev !== undefined) process.env.WIKI_HOST = prev;
    }
  });

  it("throws on unknown flags", () => {
    expect(() =>
      parseArgs(["docid", "--url", "http://x", "--space", "s", "--unknown", "val"]),
    ).toThrow("Unknown argument: --unknown");
  });
});
