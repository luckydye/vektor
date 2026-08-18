import { afterEach, describe, expect, it } from "vitest";
import {
  ApiClient,
  type Category,
  type Comment,
  type DocumentWithProperties,
  type Space,
} from "#api/ApiClient.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function client(): ApiClient {
  const api = new ApiClient({ baseUrl: "https://api.example.test" });
  api.setReplicaScope("user:one");
  return api;
}

function makeDocument(
  overrides: Partial<DocumentWithProperties> & { id: string },
): DocumentWithProperties {
  return {
    slug: overrides.id,
    type: "document",
    content: "",
    currentRev: 1,
    publishedRev: null,
    parentId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdBy: "user_1",
    updatedBy: "user_1",
    properties: {},
    ...overrides,
  };
}

/** The list endpoint returns metadata without bodies. */
function listResponse(documents: DocumentWithProperties[]) {
  return {
    documents: documents.map((document) => ({ ...document, content: "" })),
    total: documents.length,
    limit: 500,
    nextCursor: null,
  };
}

describe("cached rows", () => {
  it("serves a list from rows, in the order the server listed them", async () => {
    const api = client();
    const documents = [
      makeDocument({ id: "document_2", properties: { title: "Second" } }),
      makeDocument({ id: "document_1", properties: { title: "First" } }),
    ];
    globalThis.fetch = (async () =>
      Response.json(listResponse(documents))) as typeof fetch;

    await api.documents.get("space_1", { limit: 500 });

    const cached = await api.documents.getCached("space_1");
    expect(cached?.map((document) => document.id)).toEqual(["document_2", "document_1"]);
    expect(cached?.[0].properties).toEqual({ title: "Second" });
  });

  it("does not answer with a listed document that has no body", async () => {
    const api = client();
    globalThis.fetch = (async () =>
      Response.json(listResponse([makeDocument({ id: "document_1" })]))) as typeof fetch;

    await api.documents.get("space_1", { limit: 500 });

    // Hydrating a document view from a listing row would render it empty.
    expect(await api.document.getCached("space_1", "document_1")).toBeUndefined();
  });

  it("keeps a document body when the same document is listed afterwards", async () => {
    const api = client();
    const document = makeDocument({ id: "document_1", content: "<p>Body</p>" });
    globalThis.fetch = (async (input) =>
      String(input).includes("/documents/document_1")
        ? Response.json({ document })
        : Response.json(listResponse([document]))) as typeof fetch;

    await api.document.get("space_1", "document_1");
    await api.documents.get("space_1", { limit: 500 });

    expect((await api.document.getCached("space_1", "document_1"))?.content).toBe(
      "<p>Body</p>",
    );
  });

  it("reads a document by slug through the row index", async () => {
    const api = client();
    const document = makeDocument({
      id: "document_1",
      slug: "getting-started",
      content: "<p>Body</p>",
    });
    globalThis.fetch = (async () => Response.json({ document })) as typeof fetch;

    await api.document.get("space_1", "document_1");

    expect((await api.document.getCached("space_1", "getting-started"))?.id).toBe(
      "document_1",
    );
  });

  it("shows a newly created document in the cached list", async () => {
    const api = client();
    const created = makeDocument({ id: "document_2", content: "<p>New</p>" });
    globalThis.fetch = (async (_input, init) =>
      init?.method === "POST"
        ? Response.json({ document: created })
        : Response.json(
            listResponse([makeDocument({ id: "document_1" })]),
          )) as typeof fetch;

    await api.documents.get("space_1", { limit: 500 });
    await api.documents.post("space_1", { content: "<p>New</p>" });

    expect((await api.documents.getCached("space_1"))?.map((d) => d.id)).toEqual([
      "document_1",
      "document_2",
    ]);
  });

  it("drops an archived document from the list but keeps it readable", async () => {
    const api = client();
    const document = makeDocument({ id: "document_1", content: "<p>Body</p>" });
    globalThis.fetch = (async (input, init) => {
      if (init?.method === "DELETE") return Response.json({ success: true });
      return String(input).includes("/documents/document_1")
        ? Response.json({ document })
        : Response.json(listResponse([document]));
    }) as typeof fetch;

    await api.documents.get("space_1", { limit: 500 });
    await api.document.get("space_1", "document_1");
    await api.document.archive("space_1", "document_1");

    expect(await api.documents.getCached("space_1")).toEqual([]);
    expect((await api.document.getCached("space_1", "document_1"))?.archived).toBe(true);
  });

  it("removes a deleted document from every list it appeared in", async () => {
    const api = client();
    const document = makeDocument({
      id: "document_1",
      properties: { category: "planning" },
    });
    globalThis.fetch = (async (input, init) => {
      if (init?.method === "DELETE") return Response.json({ success: true });
      return String(input).includes("grouped=true")
        ? Response.json({
            documentsByCategory: { planning: [document] },
            categorySlugs: ["planning"],
          })
        : Response.json(listResponse([document]));
    }) as typeof fetch;

    await api.documents.get("space_1", { limit: 500 });
    await api.documents.getByCategories("space_1", ["planning"]);
    await api.document.delete("space_1", "document_1");

    expect(await api.documents.getCached("space_1")).toEqual([]);
    expect(await api.documents.getByCategoriesCached("space_1", ["planning"])).toEqual({
      planning: [],
    });
  });

  it("treats a partially cached category request as a miss", async () => {
    const api = client();
    globalThis.fetch = (async () =>
      Response.json({
        documentsByCategory: { planning: [] },
        categorySlugs: ["planning"],
      })) as typeof fetch;

    await api.documents.getByCategories("space_1", ["planning"]);

    expect(
      await api.documents.getByCategoriesCached("space_1", ["planning", "design"]),
    ).toBeUndefined();
  });

  it("does not list a document it has only ever seen in one category", async () => {
    const api = client();
    globalThis.fetch = (async () =>
      Response.json({
        documentsByCategory: { planning: [makeDocument({ id: "document_1" })] },
        categorySlugs: ["planning"],
      })) as typeof fetch;

    await api.documents.getByCategories("space_1", ["planning"]);

    // The row exists, but no space listing has been fetched to place it in.
    expect(await api.documents.getCached("space_1")).toBeUndefined();
  });

  it("hydrates spaces, categories, comments and extensions from rows", async () => {
    const api = client();
    const space: Space = {
      id: "space_1",
      name: "One",
      slug: "one",
      createdBy: "user_1",
      preferences: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const category: Category = {
      id: "category_1",
      name: "Planning",
      slug: "planning",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const comment: Comment = {
      id: "comment_1",
      resourceType: "document",
      resourceId: "document_1",
      content: "Looks good",
      reference: null,
      parentId: null,
      type: "text",
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "user_1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/categories"))
        return Response.json({ categories: [category], hasHiddenCategories: true });
      if (url.includes("/comments")) return Response.json({ comments: [comment] });
      if (url.includes("/extensions"))
        return Response.json({ extensions: [], errors: [] });
      return Response.json([space]);
    }) as typeof fetch;

    await api.spaces.get();
    await api.categories.get("space_1");
    await api.comments.get("space_1", "document_1");
    await api.extensions.get("space_1");

    expect(await api.spaces.getCached()).toEqual([space]);
    expect(await api.categories.getCached("space_1")).toEqual({
      categories: [category],
      hasHiddenCategories: true,
    });
    expect(await api.comments.getCached("space_1", "document_1")).toEqual([comment]);
    expect(await api.extensions.getCached("space_1")).toEqual({
      extensions: [],
      errors: [],
    });
  });

  it("caches nothing without an identity scope", async () => {
    const api = new ApiClient({ baseUrl: "https://api.example.test" });
    globalThis.fetch = (async () =>
      Response.json(listResponse([makeDocument({ id: "document_1" })]))) as typeof fetch;

    await api.documents.get("space_1", { limit: 500 });

    expect(await api.documents.getCached("space_1")).toBeUndefined();
  });
});

describe("optimistic rows", () => {
  it("shows a local edit and then the server's version of the row", async () => {
    const api = client();
    const existing: Category = {
      id: "category_1",
      name: "Before",
      slug: "before",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const remote: Category = { ...existing, name: "From server", slug: "from-server" };
    let allowResponse!: () => void;
    let signalRequestStarted!: () => void;
    const responseAllowed = new Promise<void>((resolve) => {
      allowResponse = resolve;
    });
    const requestStarted = new Promise<void>((resolve) => {
      signalRequestStarted = resolve;
    });

    globalThis.fetch = (async (_input, init) => {
      if (init?.method === "PUT") {
        signalRequestStarted();
        await responseAllowed;
        return Response.json({ category: remote });
      }
      return Response.json({ categories: [existing], hasHiddenCategories: false });
    }) as typeof fetch;

    await api.categories.get("space_1");
    const updating = api.category.put("space_1", existing.id, { name: "Local" });
    await requestStarted;

    expect((await api.categories.getCached("space_1"))?.categories[0].name).toBe("Local");

    allowResponse();
    await updating;

    expect((await api.categories.getCached("space_1"))?.categories[0]).toEqual(remote);
  });

  it("restores the row a failed request had changed", async () => {
    const api = client();
    const document = makeDocument({ id: "document_1", content: "<p>Before</p>" });
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === "PUT") return new Response("nope", { status: 500 });
      return Response.json({ document });
    }) as typeof fetch;

    await api.document.get("space_1", "document_1");
    await expect(
      api.document.putCode("space_1", "document_1", "<p>After</p>"),
    ).rejects.toThrow();

    expect((await api.document.getCached("space_1", "document_1"))?.content).toBe(
      "<p>Before</p>",
    );
  });

  it("keeps a server response that landed while a request was failing", async () => {
    const api = client();
    const document = makeDocument({ id: "document_1", content: "<p>Before</p>" });
    let allowFailure!: () => void;
    let signalRequestStarted!: () => void;
    const failureAllowed = new Promise<void>((resolve) => {
      allowFailure = resolve;
    });
    const requestStarted = new Promise<void>((resolve) => {
      signalRequestStarted = resolve;
    });

    let served = document;
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === "PUT") {
        signalRequestStarted();
        await failureAllowed;
        return new Response("nope", { status: 500 });
      }
      return Response.json({ document: served });
    }) as typeof fetch;

    await api.document.get("space_1", "document_1");
    const failing = api.document.putCode("space_1", "document_1", "<p>Local</p>");
    await requestStarted;

    // A newer server answer owns the row; the rollback must leave it alone.
    served = { ...document, content: "<p>Remote</p>" };
    await api.document.get("space_1", "document_1");
    allowFailure();
    await expect(failing).rejects.toThrow();

    expect((await api.document.getCached("space_1", "document_1"))?.content).toBe(
      "<p>Remote</p>",
    );
  });

  it("swaps a pending comment for the stored one, keeping its place", async () => {
    const api = client();
    const stored: Comment = {
      id: "comment_2",
      resourceType: "document",
      resourceId: "document_1",
      content: "New",
      reference: null,
      parentId: null,
      type: "text",
      createdAt: "2026-01-02T00:00:00.000Z",
      createdBy: "user_1",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    globalThis.fetch = (async (_input, init) =>
      init?.method === "POST"
        ? Response.json({ comment: stored })
        : Response.json({ comments: [] })) as typeof fetch;

    await api.comments.get("space_1", "document_1");
    await api.comments.post("space_1", "document_1", {
      content: "New",
      parentId: null,
      reference: null,
      type: "text",
    });

    expect(await api.comments.getCached("space_1", "document_1")).toEqual([stored]);
  });
});
