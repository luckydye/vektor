import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
function loaderContext(publicDir = "/tmp/vektor-loader-test") {
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
      config: { publicDir: pathToFileURL(`${publicDir}/`) },
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

  test("downloads video, poster and <source> assets alongside images", async () => {
    const assetsDir = join(tmpdir(), `vektor-loader-media-${Date.now()}`);
    const content =
      '<video controls poster="https://cdn.test/still.svg" ' +
      'src="https://cdn.test/clip.mp4"></video>' +
      '<video><source src="https://cdn.test/other.webm" type="video/webm"></video>' +
      '<a href="https://cdn.test/clip.mp4">download</a>';

    const fetched: string[] = [];
    const client = createVektorClient({
      baseUrl: "https://cdn.test",
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
        if (url.pathname.endsWith("/documents/doc-1")) {
          return Response.json({ document: { ...listedDocument, content } });
        }
        fetched.push(url.pathname);
        const type = url.pathname.endsWith(".svg") ? "image/svg+xml" : "video/mp4";
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-type": type },
        });
      },
    });

    const { context, store } = loaderContext(assetsDir);
    const loader = vektorLoader(client, { spaceId: "space-1", assetMode: "download" });

    // biome-ignore lint/suspicious/noExplicitAny: minimal stand-in for Astro's context
    await loader.load(context as any);

    expect(fetched.sort()).toEqual(["/clip.mp4", "/other.webm", "/still.svg"]);

    const rewritten = store.get("hello")?.data.content as string;
    // Media attributes now point at the cached copies, extension preserved.
    expect(rewritten).toMatch(/src="\/vektor-assets\/[0-9a-f]{16}\.mp4"/);
    expect(rewritten).toMatch(/src="\/vektor-assets\/[0-9a-f]{16}\.webm"/);
    expect(rewritten).toMatch(/poster="\/vektor-assets\/[0-9a-f]{16}\.svg"/);
    // Links are not media, so their URLs stay remote.
    expect(rewritten).toContain('href="https://cdn.test/clip.mp4"');

    rmSync(assetsDir, { recursive: true, force: true });
  });
});
