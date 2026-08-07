import { describe, expect, test } from "bun:test";
import { createVektorClient, type Document } from "#index";
import { vektorLoader } from "#loader";

const listedDocument: Document = {
  id: "doc-1",
  slug: "hello",
  currentRev: 2,
  publishedRev: 1,
  properties: { title: "Hello", sourceCollection: "post" },
  parentId: null,
  readonly: false,
  archived: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdBy: "user-1",
};

/** The subset of Astro's loader context that vektorLoader actually touches. */
function loaderContext() {
  const store = new Map<string, { id: string; data: Record<string, unknown> }>();
  const meta = new Map<string, string>();
  const warnings: string[] = [];
  return {
    warnings,
    store,
    context: {
      store: {
        set: (entry: { id: string; data: Record<string, unknown> }) =>
          store.set(entry.id, entry),
        keys: () => [...store.keys()],
        delete: (key: string) => store.delete(key),
      },
      meta,
      logger: {
        info: () => {},
        warn: (message: string) => warnings.push(message),
      },
      generateDigest: (value: unknown) => JSON.stringify(value),
      config: { publicDir: new URL("file:///tmp/vektor-loader-test/") },
    },
  };
}

describe("vektorLoader", () => {
  test("falls back to published content when a token may not read drafts", async () => {
    const requested: string[] = [];
    const client = createVektorClient({
      accessToken: "at_viewer",
      fetch: async (input) => {
        const url = new URL(input.toString());
        requested.push(`${url.pathname}${url.search}`);

        if (url.pathname.endsWith("/documents")) {
          return Response.json({
            documents: [listedDocument],
            total: 1,
            limit: 500,
            nextCursor: null,
          });
        }
        // Drafts need editor permission; this token only has viewer.
        if (url.searchParams.get("draft") === "true") {
          return Response.json({ error: "Forbidden" }, { status: 403 });
        }
        return Response.json({
          document: { ...listedDocument, content: "<p>published</p>" },
        });
      },
    });

    const { context, store, warnings } = loaderContext();
    const loader = vektorLoader(client, {
      spaceId: "space-1",
      revision: "current",
      assetMode: "remote",
    });

    // biome-ignore lint/suspicious/noExplicitAny: minimal stand-in for Astro's context
    await loader.load(context as any);

    expect(store.get("hello")?.data.content).toBe("<p>published</p>");
    expect(requested).toEqual([
      "/api/v1/spaces/space-1/documents?limit=500",
      "/api/v1/spaces/space-1/documents/doc-1?draft=true",
      "/api/v1/spaces/space-1/documents/doc-1",
    ]);
    expect(warnings.join(" ")).toContain("editor-scoped");
  });

  test("keeps multi-value properties as lists", async () => {
    const client = createVektorClient({
      fetch: async (input) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/documents")) {
          return Response.json({
            documents: [listedDocument],
            total: 1,
            limit: 500,
            nextCursor: null,
          });
        }
        return Response.json({
          document: {
            ...listedDocument,
            content: "<p>hi</p>",
            properties: {
              ...listedDocument.properties,
              tags: ["project", "webdev"],
              title: ["First", "Second"],
            },
          },
        });
      },
    });

    const { context, store } = loaderContext();
    const loader = vektorLoader(client, {
      spaceId: "space-1",
      assetMode: "remote",
    });

    // biome-ignore lint/suspicious/noExplicitAny: minimal stand-in for Astro's context
    await loader.load(context as any);

    const entry = store.get("hello");
    expect(entry?.data.properties).toMatchObject({ tags: ["project", "webdev"] });
    // The flattened title stays a plain string for consumers that render it directly.
    expect(entry?.data.title).toBe("First, Second");
  });
});
