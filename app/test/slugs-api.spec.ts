/**
 * The endpoints that apply the slug rules: document creation must never refuse a
 * title, and space creation and update must refuse a slug that cannot be reached
 * or that another space already owns.
 *
 * The rules themselves are pinned in `slugs.spec.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createApiRequest,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7493;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let spaceId: string;

async function createSpace(name: string, slug: string): Promise<Response> {
  return apiRequest("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({ name, slug }),
  });
}

async function patchSpaceSlug(id: string, slug: string): Promise<Response> {
  return apiRequest(`/api/v1/spaces/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ slug }),
  });
}

async function createDocument(title: string): Promise<Response> {
  return apiRequest(`/api/v1/spaces/${spaceId}/documents`, {
    method: "POST",
    body: JSON.stringify({ content: `<p>${title}</p>`, properties: { title } }),
  });
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_API_ONLY: "1",
    VEKTOR_NO_AUTH: "1",
  });
  await waitForServer(BASE_URL);

  const response = await createSpace("Slug Test Space", "slug-test");
  if (response.status !== 201) {
    throw new Error(
      `Failed to create space: ${response.status} ${await response.text()}`,
    );
  }
  spaceId = (await response.json()).space.id;
}, 30_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("document creation with a non-Latin title", () => {
  // Every one of these used to be a 400 "Title must contain at least one letter
  // or number", which locked non-Latin-script users out of creating documents.
  const titles = ["日本語のドキュメント", "Привет мир", "مرحبا", "한국어", "Ελλάδα"];

  for (const title of titles) {
    it(`creates a document titled ${title}`, async () => {
      const response = await createDocument(title);
      expect(response.status).toBe(201);

      const { document } = await response.json();
      // The title is kept intact; only the URL falls back to a generated slug.
      expect(document.properties.title).toBe(title);
      expect(document.slug).toMatch(/^document-[0-9a-f]{8}$/);
    });
  }

  it("gives two unsluggable titles different slugs", async () => {
    const first = await (await createDocument("シラバス")).json();
    const second = await (await createDocument("シラバス")).json();
    expect(first.document.slug).not.toBe(second.document.slug);
  });

  it("creates a document with a symbol-only title", async () => {
    const response = await createDocument("-----");
    expect(response.status).toBe(201);
    expect((await response.json()).document.slug).toMatch(/^document-[0-9a-f]{8}$/);
  });

  it("takes a readable slug once the title becomes one the URL can carry", async () => {
    // A generated slug names the document no better than "untitled-document"
    // does, so the first title that slugifies has to replace it — otherwise a
    // document first named in Japanese keeps `document-1a2b3c4d` for good.
    const created = (await (await createDocument("会議のメモ")).json()).document;
    expect(created.slug).toMatch(/^document-[0-9a-f]{8}$/);

    const renamed = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${created.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ properties: { title: "Meeting Notes" } }),
      },
    );
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).slug).toBe("meeting-notes");
  });

  it("keeps the generated slug when the new title is unsluggable too", async () => {
    const created = (await (await createDocument("設計メモ")).json()).document;
    const renamed = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${created.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ properties: { title: "実装メモ" } }),
      },
    );
    expect(renamed.status).toBe(200);

    const fetched = await (
      await apiRequest(`/api/v1/spaces/${spaceId}/documents/${created.id}`)
    ).json();
    expect(fetched.document.properties.title).toBe("実装メモ");
    expect(fetched.document.slug).toBe(created.slug);
  });
});

describe("document creation with diacritics", () => {
  const expected: Array<[string, string]> = [
    ["Café", "cafe"],
    ["Über uns", "uber-uns"],
    ["Ärger", "arger"],
    ["Æther", "aether"],
  ];

  for (const [title, slug] of expected) {
    it(`slugs ${title} as ${slug}`, async () => {
      const response = await createDocument(title);
      expect(response.status).toBe(201);
      expect((await response.json()).document.slug).toBe(slug);
    });
  }
});

describe("space creation", () => {
  it("rejects a slug reserved by the app's own routes", async () => {
    for (const slug of ["docs", "login", "api", "new", "404"]) {
      const response = await createSpace(`Space ${slug}`, slug);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/reserved/);
    }
  });

  it("rejects the reserved names no slug could spell anyway", async () => {
    // `_astro`, `.well-known` and `favicon.ico` are refused as malformed before
    // the reserved list is consulted; they are listed there for completeness.
    for (const slug of ["_astro", ".well-known", "favicon.ico"]) {
      expect((await createSpace("Reserved", slug)).status).toBe(400);
    }
  });

  it("rejects a malformed slug instead of storing it", async () => {
    for (const slug of ["has spaces", "a/b/c", "UPPER💥", "special!@#$%space"]) {
      const response = await createSpace("Malformed", slug);
      expect(response.status).toBe(400);
    }
  });

  it("rejects a slug with nothing sluggable in it", async () => {
    const response = await createSpace("日本語", "日本語");
    expect(response.status).toBe(400);
  });

  it("rejects a slug another space already owns", async () => {
    const response = await createSpace("Slug Test Space Again", "slug-test");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/already exists/);
  });
});

describe("space update", () => {
  let renamableId: string;

  beforeAll(async () => {
    const response = await createSpace("Renamable", "renamable");
    expect(response.status).toBe(201);
    renamableId = (await response.json()).space.id;
  });

  it("accepts a canonical slug", async () => {
    const response = await patchSpaceSlug(renamableId, "renamed");
    expect(response.status).toBe(200);
    expect((await response.json()).slug).toBe("renamed");
  });

  it("rejects a malformed slug", async () => {
    for (const slug of ["has spaces", "a/b/c", "UPPER💥"]) {
      const response = await patchSpaceSlug(renamableId, slug);
      expect(response.status).toBe(400);
    }

    // Unchanged, rather than stored verbatim as it used to be.
    const space = await (await apiRequest(`/api/v1/spaces/${renamableId}`)).json();
    expect(space.slug).toBe("renamed");
  });

  it("rejects a reserved slug", async () => {
    const response = await patchSpaceSlug(renamableId, "docs");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/reserved/);
  });

  it("rejects a slug another space already owns", async () => {
    // The serious one: this used to answer 200 and hide the other space for good.
    const response = await patchSpaceSlug(renamableId, "slug-test");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/already exists/);

    const other = await (await apiRequest(`/api/v1/spaces/${spaceId}`)).json();
    expect(other.slug).toBe("slug-test");
  });

  it("accepts the slug the space already holds", async () => {
    const response = await patchSpaceSlug(renamableId, "renamed");
    expect(response.status).toBe(200);
    expect((await response.json()).slug).toBe("renamed");
  });

  it("renames without touching the slug", async () => {
    const response = await apiRequest(`/api/v1/spaces/${renamableId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed Space" }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.name).toBe("Renamed Space");
    expect(body.slug).toBe("renamed");
  });
});
