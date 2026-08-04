import { describe, expect, test } from "bun:test";
import {
  createVektorClient,
  DEFAULT_VEKTOR_URL,
  type Document,
  propertyScalar,
  propertyText,
  VektorApiError,
} from "#index";

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
        return Response.json({ documents: [], total: 0, limit: 12, nextCursor: null });
      },
    });

    await client.listDocuments("space/id", { limit: 12, cursor: "abc" });

    expect(request?.url).toBe(
      `${DEFAULT_VEKTOR_URL}/api/v1/spaces/space%2Fid/documents?limit=12&cursor=abc`,
    );
    expect(request?.headers.get("Authorization")).toBe("Bearer at_example");
  });

  test("resolves a slug in one request against the document route", async () => {
    const paths: string[] = [];
    const client = createVektorClient({
      baseUrl: "https://vektor.example/",
      fetch: async (input) => {
        paths.push(new URL(input.toString()).pathname);
        return Response.json({
          document: { ...listedDocument, content: "<p>Hello</p>" },
          space: { id: "space-1", slug: "space", name: "Space" },
        });
      },
    });

    const document = await client.getDocumentBySlug("space-1", "hello-world");

    expect(document?.content).toBe("<p>Hello</p>");
    expect(paths).toEqual(["/api/v1/spaces/space-1/documents/hello-world"]);
  });

  test("treats a missing or invisible slug as undefined", async () => {
    for (const status of [403, 404]) {
      const client = createVektorClient({
        accessToken: "at_example",
        fetch: async () => Response.json({ error: "Nope" }, { status }),
      });
      expect(await client.getDocumentBySlug("space-1", "ghost")).toBeUndefined();
    }
  });

  test("reports a rejected token instead of reporting the slug absent", async () => {
    const unauthorized = async () => Response.json({ error: "Nope" }, { status: 401 });

    // No token: 401 means the document simply is not public.
    const anonymous = createVektorClient({ fetch: unauthorized });
    expect(await anonymous.getDocumentBySlug("space-1", "private")).toBeUndefined();

    // With a token, 401 is a rejected token and must not look like an empty space.
    const authenticated = createVektorClient({
      accessToken: "at_expired",
      fetch: unauthorized,
    });
    await expect(authenticated.getDocumentBySlug("space-1", "private")).rejects.toThrow(
      VektorApiError,
    );
  });

  test("requests the draft only when asked", async () => {
    const urls: string[] = [];
    const client = createVektorClient({
      fetch: async (input) => {
        urls.push(new URL(input.toString()).search);
        return Response.json({ document: listedDocument });
      },
    });

    await client.getDocument("space-1", "doc-1");
    await client.getDocument("space-1", "doc-1", { draft: true });

    expect(urls).toEqual(["", "?draft=true"]);
  });

  test("reads multi-value properties", () => {
    const tags: Document["properties"] = { tags: ["a", "b"], title: "One" };
    expect(propertyText(tags.tags)).toBe("a, b");
    expect(propertyScalar(tags.tags)).toBe("a");
    expect(propertyScalar(tags.title)).toBe("One");
    expect(propertyScalar(undefined)).toBeUndefined();
  });

  test("sends category slugs as one comma-joined parameter", async () => {
    let url: string | undefined;
    const client = createVektorClient({
      fetch: async (input) => {
        url = input.toString();
        return Response.json({ documents: [], total: 0, limit: 50, nextCursor: null });
      },
    });

    await client.listDocuments("space-1", { categorySlugs: ["news", "blog"] });

    expect(new URL(url!).searchParams.get("categorySlugs")).toBe("news,blog");
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
