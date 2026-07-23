/**
 * Integration tests for the noAuth + in-memory server mode.
 *
 * The suite spawns its own isolated server process so it can be run
 * standalone without a pre-existing server, and without touching the
 * filesystem (no data/ directory is created or modified).
 *
 * Run with:
 *   bun test test/in-memory.spec.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  createApiRequest,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7475;
const BASE_URL = testBaseUrl(PORT);
const api = createApiRequest(BASE_URL);

let serverProcess: TestServerProcess;

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_NO_AUTH: "1",
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_API_ONLY: "1",
  });

  await waitForServer(BASE_URL);
});

afterAll(() => {
  serverProcess?.kill();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiJson<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await api(path, options);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${options.method ?? "GET"} ${path} → ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Test state shared across suites
// ---------------------------------------------------------------------------

let spaceId: string;
const docIds: string[] = [];

// ---------------------------------------------------------------------------
// Space tests
// ---------------------------------------------------------------------------

describe("in-memory server — spaces", () => {
  it("starts with an empty space list", async () => {
    const spaces = await apiJson<unknown[]>("/api/v1/spaces");
    expect(Array.isArray(spaces)).toBe(true);
    expect(spaces.length).toBe(0);
  });

  it("creates a space", async () => {
    const res = await api("/api/v1/spaces", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Space",
        slug: "test-space",
        preferences: { brandColor: "#1e293b" },
      }),
    });

    expect(res.status).toBe(201);
    const { space } = await res.json();

    expect(space.id).toBeString();
    expect(space.id).toStartWith("space_");
    expect(space.name).toBe("Test Space");
    expect(space.slug).toBe("test-space");
    expect(space.preferences?.brandColor).toBe("#1e293b");

    spaceId = space.id;
  });

  it("retrieves the created space by id", async () => {
    const space = await apiJson<{
      id: string;
      name: string;
      slug: string;
    }>(`/api/v1/spaces/${spaceId}`);

    expect(space.id).toBe(spaceId);
    expect(space.name).toBe("Test Space");
    expect(space.slug).toBe("test-space");
  });

  it("lists the created space", async () => {
    const spaces = await apiJson<{ id: string }[]>("/api/v1/spaces");

    expect(Array.isArray(spaces)).toBe(true);
    expect(spaces.length).toBe(1);
    expect(spaces[0].id).toBe(spaceId);
  });

  it("returns 404 for a non-existent space", async () => {
    const res = await api("/api/v1/spaces/space_doesnotexist");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Document tests
// ---------------------------------------------------------------------------

describe("in-memory server — documents", () => {
  it("starts with an empty document list", async () => {
    const { documents } = await apiJson<{ documents: unknown[] }>(
      `/api/v1/spaces/${spaceId}/documents`,
    );
    expect(Array.isArray(documents)).toBe(true);
    expect(documents.length).toBe(0);
  });

  it("creates a first document with markdown content", async () => {
    const res = await api(`/api/v1/spaces/${spaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "# Getting Started\n\nWelcome to the test space.",
        properties: { title: "Getting Started" },
      }),
    });

    expect(res.status).toBe(201);
    const { document } = await res.json();

    expect(document.id).toBeString();
    expect(document.id).toStartWith("doc_");
    expect(document.content).toBe("# Getting Started\n\nWelcome to the test space.");
    expect(document.properties.title).toBe("Getting Started");
    expect(document.parentId).toBeNull();
    expect(document.archived).toBe(false);

    docIds.push(document.id);
  });

  it("creates a second document with different content", async () => {
    const res = await api(`/api/v1/spaces/${spaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "# Architecture\n\nThis document describes the system architecture.",
        properties: { title: "Architecture" },
      }),
    });

    expect(res.status).toBe(201);
    const { document } = await res.json();

    expect(document.id).toStartWith("doc_");
    expect(document.content).toBe(
      "# Architecture\n\nThis document describes the system architecture.",
    );
    expect(document.properties.title).toBe("Architecture");
    expect(document.id).not.toBe(docIds[0]);

    docIds.push(document.id);
  });

  it("creates a third document as a child of the first", async () => {
    const res = await api(`/api/v1/spaces/${spaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "# Installation\n\nFollow these steps to install.",
        properties: { title: "Installation" },
        parentId: docIds[0],
      }),
    });

    expect(res.status).toBe(201);
    const { document } = await res.json();

    expect(document.id).toStartWith("doc_");
    expect(document.content).toBe("# Installation\n\nFollow these steps to install.");
    expect(document.properties.title).toBe("Installation");
    expect(document.parentId).toBe(docIds[0]);

    docIds.push(document.id);
  });

  it("lists all three documents", async () => {
    const { documents } = await apiJson<{ documents: { id: string }[] }>(
      `/api/v1/spaces/${spaceId}/documents`,
    );

    expect(documents.length).toBe(3);
    const ids = documents.map((d) => d.id);
    expect(ids).toContain(docIds[0]);
    expect(ids).toContain(docIds[1]);
    expect(ids).toContain(docIds[2]);
  });

  it("retrieves each document individually and verifies content", async () => {
    const expected = [
      {
        title: "Getting Started",
        content: "# Getting Started\n\nWelcome to the test space.",
      },
      {
        title: "Architecture",
        content: "# Architecture\n\nThis document describes the system architecture.",
      },
      {
        title: "Installation",
        content: "# Installation\n\nFollow these steps to install.",
      },
    ];

    for (let i = 0; i < docIds.length; i++) {
      const { document } = await apiJson<{
        document: { id: string; content: string; properties: { title: string } };
      }>(`/api/v1/spaces/${spaceId}/documents/${docIds[i]}`);

      expect(document.id).toBe(docIds[i]);
      expect(document.content).toBe(expected[i].content);
      expect(document.properties.title).toBe(expected[i].title);
    }
  });

  it("returns the child document under the first document's children", async () => {
    const { children } = await apiJson<{ children: { id: string }[] }>(
      `/api/v1/spaces/${spaceId}/documents/${docIds[0]}/children`,
    );

    expect(Array.isArray(children)).toBe(true);
    expect(children.length).toBe(1);
    expect(children[0].id).toBe(docIds[2]);
  });

  it("returns 404 for a non-existent document", async () => {
    const res = await api(`/api/v1/spaces/${spaceId}/documents/doc_doesnotexist`);
    expect(res.status).toBe(404);
  });

  it("updates a document's content", async () => {
    const updatedContent = "# Getting Started (revised)\n\nUpdated introduction.";
    const res = await api(`/api/v1/spaces/${spaceId}/documents/${docIds[0]}`, {
      method: "PUT",
      body: JSON.stringify({ content: updatedContent }),
    });

    expect(res.status).toBe(200);
    const { document } = await res.json();
    expect(document.content).toBeUndefined();

    // Confirm the change persists in a subsequent GET
    const { document: fetched } = await apiJson<{
      document: { content: string };
    }>(`/api/v1/spaces/${spaceId}/documents/${docIds[0]}`);
    expect(fetched.content).toBe(updatedContent);
  });

  it("archives a document (soft delete)", async () => {
    const res = await api(`/api/v1/spaces/${spaceId}/documents/${docIds[1]}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    // Archived document is still accessible but flagged
    const { document } = await apiJson<{ document: { archived: boolean } }>(
      `/api/v1/spaces/${spaceId}/documents/${docIds[1]}`,
    );
    expect(document.archived).toBe(true);

    // Active list no longer includes it
    const { documents } = await apiJson<{ documents: { id: string }[] }>(
      `/api/v1/spaces/${spaceId}/documents`,
    );
    expect(documents.some((d) => d.id === docIds[1])).toBe(false);
  });
});
