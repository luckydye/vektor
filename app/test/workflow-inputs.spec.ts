import { describe, expect, it } from "vitest";
import { parseWorkflowInputFields } from "#documents/workflowInputs.ts";

/** Name and requiredness only; the widget `kind` has its own tests below. */
function namesOf(code: string) {
  return parseWorkflowInputFields(code).map(({ name, required }) => ({ name, required }));
}

describe("parseWorkflowInputFields", () => {
  it("finds dot, optional-chain and bracket reads", () => {
    expect(
      namesOf(`
        const a = input.url;
        const b = input?.depth;
        const c = input["output name"];
      `),
    ).toEqual([
      { name: "url", required: true },
      { name: "depth", required: true },
      { name: "output name", required: true },
    ]);
  });

  it("treats a read with its own fallback as optional", () => {
    expect(
      namesOf(`
        const limit = input.limit ?? 10;
        const format = input.format || "html";
      `),
    ).toEqual([
      { name: "limit", required: false },
      { name: "format", required: false },
    ]);
  });

  it("orders fields the way the script reads them, not by pattern", () => {
    expect(
      namesOf(`
        const { sitemapUrl } = input;
        const limit = input.limit ?? 10;
      `),
    ).toEqual([
      { name: "sitemapUrl", required: true },
      { name: "limit", required: false },
    ]);
  });

  it("finds destructured inputs and their defaults", () => {
    expect(namesOf(`const { url, limit = 5, format: fmt, ...rest } = input;`)).toEqual([
      { name: "url", required: true },
      { name: "limit", required: false },
      { name: "format", required: true },
    ]);
  });

  it("reports a name once, optional if any read can cope without it", () => {
    expect(
      namesOf(`
        log(input.url);
        const url = input.url ?? "https://example.com";
      `),
    ).toEqual([{ name: "url", required: false }]);
  });

  it("ignores commented-out reads without tripping over URLs in strings", () => {
    expect(
      namesOf(`
        // const old = input.legacy;
        /* input.alsoGone */
        const result = await runJob('x', 'y', { file: "https://a.example", key: input.key });
      `),
    ).toEqual([{ name: "key", required: true }]);
  });

  it("returns nothing for a script that reads no input", () => {
    expect(parseWorkflowInputFields(`return { ok: true };`)).toEqual([]);
  });

  it("asks for an upload for file inputs and a document for id inputs", () => {
    expect(
      parseWorkflowInputFields(`
        const { file, csvFile, source_file, docId, targetDocumentId } = input;
        const profile = input.profile;
        const fileName = input.fileName;
      `),
    ).toEqual([
      { name: "file", required: true, kind: "file" },
      { name: "csvFile", required: true, kind: "file" },
      { name: "source_file", required: true, kind: "file" },
      { name: "docId", required: true, kind: "document" },
      { name: "targetDocumentId", required: true, kind: "document" },
      { name: "profile", required: true, kind: "text" },
      { name: "fileName", required: true, kind: "text" },
    ]);
  });
});
