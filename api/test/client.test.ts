import { describe, expect, test } from "bun:test";
import {
  DEFAULT_VEKTOR_URL,
  VektorApiError,
  createVektorClient,
  type Document,
} from "../src/index.ts";

const listedDocument: Document = {
  id: "doc 1",
  slug: "hello-world",
  currentRev: 1,
  publishedRev: 1,
  properties: { title: "Hello world" },
  parentId: null,
  readonly: false,
  archived: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdBy: "user-1",
};

describe("VektorClient", () => {
  test("uses the local default and bearer token", async () => {
    let request: Request | undefined;
    const client = createVektorClient({
      accessToken: "at_example",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ documents: [], total: 0, limit: 12, offset: 2 });
      },
    });

    await client.listDocuments("space/id", { limit: 12, offset: 2 });

    expect(request?.url).toBe(
      `${DEFAULT_VEKTOR_URL}/api/v1/spaces/space%2Fid/documents?limit=12&offset=2`,
    );
    expect(request?.headers.get("Authorization")).toBe("Bearer at_example");
  });

  test("finds a document by slug and fetches its content", async () => {
    const paths: string[] = [];
    const client = createVektorClient({
      baseUrl: "https://vektor.example/",
      fetch: async (input) => {
        const url = new URL(input.toString());
        paths.push(url.pathname);
        if (url.pathname.endsWith("/documents")) {
          return Response.json({ documents: [listedDocument], total: 1, limit: 500, offset: 0 });
        }
        return Response.json({ document: { ...listedDocument, content: "<p>Hello</p>" } });
      },
    });

    const document = await client.getDocumentBySlug("space-1", "hello-world");

    expect(document?.content).toBe("<p>Hello</p>");
    expect(paths).toEqual([
      "/api/v1/spaces/space-1/documents",
      "/api/v1/spaces/space-1/documents/doc%201",
    ]);
  });

  test("throws a structured API error", async () => {
    const client = createVektorClient({
      fetch: async () => Response.json({ error: "Not allowed" }, { status: 403 }),
    });

    try {
      await client.listCategories("space-1");
      throw new Error("Expected the request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(VektorApiError);
      expect((error as VektorApiError).status).toBe(403);
      expect((error as Error).message).toContain("Not allowed");
    }
  });
});
