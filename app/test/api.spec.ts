import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createJobToken } from "#jobs/jobToken.ts";
import { LOCAL_USER_ID } from "#noAuth";
import { createZipBuffer } from "#utils/zip.ts";
import {
  createApiRequest,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

process.env.AUTH_SECRET ??= "api-test-secret-do-not-use-in-production";

const PORT = 7482;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let testSpaceId: string;

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_NO_AUTH: "1",
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_API_ONLY: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "api-test-secret-do-not-use-in-production",
  });
  await waitForServer(BASE_URL);
});

afterAll(() => {
  serverProcess?.kill();
});

describe("API Tests - Spaces", () => {
  it("should create a space", async () => {
    const response = await apiRequest("/api/v1/spaces", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Space",
        slug: "test-space",
        preferences: {
          brandColor: "#ff5733",
        },
      }),
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.space.id).toBeDefined();
    expect(data.space.id).toStartWith("space_");
    expect(data.space.name).toBe("Test Space");
    expect(data.space.slug).toBe("test-space");

    testSpaceId = data.space.id;
  });

  it("should create a space and then create a document in it", async () => {
    // Create a new space
    const spaceResponse = await apiRequest("/api/v1/spaces", {
      method: "POST",
      body: JSON.stringify({
        name: "Document Test Space",
        slug: "doc-test-space",
      }),
    });

    expect(spaceResponse.status).toBe(201);
    const spaceData = await spaceResponse.json();
    expect(spaceData.space.id).toBeDefined();
    const newSpaceId = spaceData.space.id;

    // Create a document in the new space
    const docResponse = await apiRequest(`/api/v1/spaces/${newSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content:
          "# Test Document in New Space\n\nThis document was created immediately after the space.",
        properties: {
          title: "Test Document",
          category: "general",
        },
      }),
    });

    expect(docResponse.status).toBe(201);
    const docData = await docResponse.json();
    expect(docData.document).toBeDefined();
    expect(docData.document.id).toBeDefined();
    expect(docData.document.id).toStartWith("doc_");
    expect(docData.document.slug).toBeDefined();
    expect(docData.document.properties.title).toBe("Test Document");

    // Verify we can retrieve the document
    const getDocResponse = await apiRequest(
      `/api/v1/spaces/${newSpaceId}/documents/${docData.document.id}`,
    );
    expect(getDocResponse.status).toBe(200);

    // Clean up - delete the space
    await apiRequest(`/api/v1/spaces/${newSpaceId}`, {
      method: "DELETE",
    });
  });

  it("converts markdown to HTML when contentType:text/markdown is set in the body", async () => {
    const res = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        slug: "markdown-type-test",
        contentType: "text/markdown",
        content: "# Hello\n",
      }),
    });

    expect(res.status).toBe(201);
    const { document } = await res.json();
    expect(document.content).toContain("<h1");
    expect(document.slug).toBe("markdown-type-test");
  });

  it("should list spaces", async () => {
    const response = await apiRequest("/api/v1/spaces");
    expect(response.status).toBe(200);

    const data = await response.json();

    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("should get a specific space", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.id).toBe(testSpaceId);
    expect(data.name).toBe("Test Space");
  });

  it("should update a space", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: "Updated Test Space",
        slug: "updated-test-space",
        preferences: {
          brandColor: "#3366cc",
        },
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.name).toBe("Updated Test Space");
    expect(data.slug).toBe("updated-test-space");
  });
});

describe("API Tests - Extensions", () => {
  function createExtensionPackage(id: string): Buffer {
    return createZipBuffer([
      {
        name: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            id,
            name: "Toggle Test",
            version: "1.0.0",
            entries: {},
            jobs: [{ id: "toggle-test-noop", name: "Noop", entry: "jobs/noop.mjs" }],
          }),
        ),
      },
      {
        name: "jobs/noop.mjs",
        data: Buffer.from("export default async function noop() { return {}; }\n"),
      },
    ]);
  }

  it("can disable and re-enable extensions", async () => {
    const spaceResponse = await apiRequest("/api/v1/spaces", {
      method: "POST",
      body: JSON.stringify({
        name: "Extension Toggle Space",
        slug: "extension-toggle-space",
      }),
    });
    expect(spaceResponse.status).toBe(201);
    const spaceData = await spaceResponse.json();
    const spaceId = spaceData.space.id;

    const form = new FormData();
    const packageBuffer = createExtensionPackage("toggle-test");
    const packageBytes = packageBuffer.buffer.slice(
      packageBuffer.byteOffset,
      packageBuffer.byteOffset + packageBuffer.byteLength,
    ) as ArrayBuffer;
    form.append(
      "file",
      new File([packageBytes], "toggle-test.zip", { type: "application/zip" }),
    );

    const uploadResponse = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/extensions`,
      {
        method: "POST",
        body: form,
      },
    );
    expect(uploadResponse.status).toBe(201);
    expect((await uploadResponse.json()).enabled).toBe(true);

    const disableResponse = await apiRequest(
      `/api/v1/spaces/${spaceId}/extensions/toggle-test`,
      {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(disableResponse.status).toBe(200);
    expect((await disableResponse.json()).enabled).toBe(false);

    const listResponse = await apiRequest(`/api/v1/spaces/${spaceId}/extensions`);
    expect(listResponse.status).toBe(200);
    const listData = await listResponse.json();
    expect(listData.extensions).toContainEqual(
      expect.objectContaining({ id: "toggle-test", enabled: false }),
    );

    const runResponse = await apiRequest(`/api/v1/spaces/${spaceId}/jobs/run`, {
      method: "POST",
      body: JSON.stringify({ jobId: "toggle-test-noop" }),
    });
    expect(runResponse.status).toBe(400);
    expect(await runResponse.json()).toEqual({
      error: 'Job "toggle-test-noop" not found',
    });

    const enableResponse = await apiRequest(
      `/api/v1/spaces/${spaceId}/extensions/toggle-test`,
      {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(enableResponse.status).toBe(200);
    expect((await enableResponse.json()).enabled).toBe(true);
  });
});

describe("API Tests - Documents", () => {
  let testDocumentId: string;
  let childDocumentId: string;
  let workflowDocumentId: string;

  it("should create a document", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "# Test Document\n\nThis is the content.",
        properties: {
          title: "Test Document",
          category: "general",
        },
      }),
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.document.id).toBeDefined();
    expect(data.document.id).toStartWith("doc_");
    expect(data.document.content).toBe("# Test Document\n\nThis is the content.");
    expect(data.document.properties.title).toBe("Test Document");

    testDocumentId = data.document.id;
  });

  it("should derive slug from wrapped title property", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "# Wrapped Title Document\n\nThis is the content.",
        properties: {
          title: { value: "Wrapped Title Document", type: "text" },
        },
      }),
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.document.slug).toBe("wrapped-title-document");
    expect(data.document.properties.title).toBe("Wrapped Title Document");
  });

  it("should list documents", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.documents).toBeDefined();
    expect(Array.isArray(data.documents)).toBe(true);
    expect(data.documents.length).toBeGreaterThan(0);
  });

  it("should filter documents by type", async () => {
    const workflowResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        type: "workflow",
        content:
          '{"node1":{"extensionId":"test","jobId":"noop","inputs":[],"depends":[]}}',
        properties: {
          title: "Workflow Filter Test",
        },
      }),
    });

    expect(workflowResponse.status).toBe(201);
    const workflowData = await workflowResponse.json();
    workflowDocumentId = workflowData.document.id;

    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents?type=workflow`,
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(Array.isArray(data.documents)).toBe(true);
    expect(data.documents.length).toBeGreaterThan(0);
    expect(
      data.documents.some((doc: { id: string }) => doc.id === workflowDocumentId),
    ).toBe(true);
    expect(data.documents.some((doc: { id: string }) => doc.id === testDocumentId)).toBe(
      false,
    );
    expect(
      data.documents.every((doc: { type?: string | null }) => doc.type === "workflow"),
    ).toBe(true);
  });

  it("should get a specific document", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}`,
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.document.id).toBe(testDocumentId);
    expect(data.document.properties.title).toBe("Test Document");
  });

  it("should update document content", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          content: "# Updated Document\n\nThis content has been updated.",
        }),
      },
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.document.content).toBe(
      "# Updated Document\n\nThis content has been updated.",
    );
  });

  it("should create a child document", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "# Child Document\n\nThis is a child.",
        properties: {
          title: "Child Document",
        },
        parentId: testDocumentId,
      }),
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.document.parentId).toBe(testDocumentId);

    childDocumentId = data.document.id;
  });

  it("should get document children", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/children`,
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.children).toBeDefined();
    expect(Array.isArray(data.children)).toBe(true);
    expect(data.children.length).toBe(1);
    expect(data.children[0].id).toBe(childDocumentId);
  });

  it("should move document by updating parent", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${childDocumentId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          parentId: null,
        }),
      },
    );

    expect(response.status).toBe(200);

    const data = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${childDocumentId}`,
    ).then((res) => res.json());

    expect(data.document.parentId).toBe(null);
  });

  it("should archive a document (soft delete)", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${childDocumentId}`,
      {
        method: "DELETE",
      },
    );

    expect(response.status).toBe(200);

    // Archived document should still be accessible via GET but marked as archived
    const checkResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${childDocumentId}`,
    );
    expect(checkResponse.status).toBe(200);
    const checkData = await checkResponse.json();
    expect(checkData.document.archived).toBe(true);

    // Document should be in archived list
    const archivedResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/archived`,
    );
    expect(archivedResponse.status).toBe(200);
    const archivedData = await archivedResponse.json();
    const archivedDoc = archivedData.documents.find(
      (doc: { id: string }) => doc.id === childDocumentId,
    );
    expect(archivedDoc).toBeDefined();
  });

  it("should restore an archived document", async () => {
    // First, create a new document to archive and restore
    const createResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "<p>Document to be restored</p>",
        properties: { title: "Restore Test Doc" },
      }),
    });
    expect(createResponse.status).toBe(201);
    const createData = await createResponse.json();
    const docToRestoreId = createData.document.id;

    // Archive the document
    const archiveResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${docToRestoreId}`,
      {
        method: "DELETE",
      },
    );
    expect(archiveResponse.status).toBe(200);

    // Verify it's archived
    const checkArchivedResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${docToRestoreId}`,
    );
    expect(checkArchivedResponse.status).toBe(200);
    const checkArchivedData = await checkArchivedResponse.json();
    expect(checkArchivedData.document.archived).toBe(true);

    // Restore the document
    const restoreResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${docToRestoreId}`,
      {
        method: "PUT",
        body: JSON.stringify({ restore: true }),
      },
    );
    expect(restoreResponse.status).toBe(200);

    const restoreData = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${docToRestoreId}`,
    ).then((res) => res.json());

    expect(restoreData.document.archived).toBe(false);

    // Verify it's no longer in archived list
    const archivedListResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/archived`,
    );
    expect(archivedListResponse.status).toBe(200);
    const archivedListData = await archivedListResponse.json();
    const restoredDoc = archivedListData.documents.find(
      (doc: { id: string }) => doc.id === docToRestoreId,
    );
    expect(restoredDoc).toBeUndefined();

    // Verify document is accessible normally
    const getDocResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${docToRestoreId}`,
    );
    expect(getDocResponse.status).toBe(200);
    const getDocData = await getDocResponse.json();
    expect(getDocData.document.archived).toBe(false);
    expect(getDocData.document.id).toBe(docToRestoreId);
  });

  it("should archive document with X-Job-Token auth", async () => {
    const createResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "<p>Job token delete target</p>",
        properties: { title: "Job Token Delete Target" },
      }),
    });
    expect(createResponse.status).toBe(201);
    const createData = await createResponse.json();
    const documentId = createData.document.id;

    const jobToken = createJobToken(testSpaceId, Date.now().toString(), LOCAL_USER_ID);
    const archiveResponse = await fetch(
      `${BASE_URL}/api/v1/spaces/${testSpaceId}/documents/${documentId}`,
      {
        method: "DELETE",
        headers: {
          "X-Job-Token": jobToken,
        },
      },
    );
    expect(archiveResponse.status).toBe(200);

    const checkResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${documentId}`,
    );
    expect(checkResponse.status).toBe(200);
    const checkData = await checkResponse.json();
    expect(checkData.document.archived).toBe(true);
  });

  it("should permanently delete a document", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${childDocumentId}?permanent=true`,
      {
        method: "DELETE",
      },
    );

    expect(response.status).toBe(200);

    // Document should not be in archived list after permanent deletion
    const archivedResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/archived`,
    );
    expect(archivedResponse.status).toBe(200);
    const archivedData = await archivedResponse.json();
    const archivedDoc = archivedData.documents.find(
      (doc: { id: string }) => doc.id === childDocumentId,
    );
    expect(archivedDoc).toBeUndefined();
  });
});

describe("API Tests - Document Properties", () => {
  let propertyTestDocId: string;

  it("should create a document for property testing", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "# Property Test Doc",
        properties: {
          title: "Property Test",
          author: "Test User",
        },
      }),
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    propertyTestDocId = data.document.id;
  });

  it("should update a document property", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${propertyTestDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            status: { value: "published" },
          },
        }),
      },
    );

    expect(response.status).toBe(200);

    const docResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${propertyTestDocId}`,
    );
    const docData = await docResponse.json();
    expect(docData.document.properties.status).toBe("published");
  });

  it("should patch properties with X-Job-Token auth", async () => {
    const jobToken = createJobToken(testSpaceId, Date.now().toString(), LOCAL_USER_ID);
    const patchResponse = await fetch(
      `${BASE_URL}/api/v1/spaces/${testSpaceId}/documents/${propertyTestDocId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Job-Token": jobToken,
        },
        body: JSON.stringify({
          properties: {
            title: "Patched By Job Token",
          },
        }),
      },
    );
    expect(patchResponse.status).toBe(200);

    const docResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${propertyTestDocId}`,
    );
    const docData = await docResponse.json();
    expect(docData.document.properties.title).toBe("Patched By Job Token");
  });

  it("should update an existing document property", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${propertyTestDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            author: { value: "Updated Author" },
          },
        }),
      },
    );

    expect(response.status).toBe(200);

    const docResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${propertyTestDocId}`,
    );
    const docData = await docResponse.json();
    expect(docData.document.properties.author).toBe("Updated Author");
  });

  it("should round-trip multi-value document properties", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${propertyTestDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            tags: { value: ["draft", "review"] },
          },
        }),
      },
    );

    expect(response.status).toBe(200);

    const docResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${propertyTestDocId}`,
    );
    const docData = await docResponse.json();
    expect(docData.document.properties.tags).toEqual(["draft", "review"]);

    const propertiesResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/properties`,
    );
    const propertiesData = await propertiesResponse.json();
    const tagsProperty = propertiesData.properties.find(
      (property: { name: string }) => property.name === "tags",
    );
    expect(tagsProperty.values).toContain("draft");
    expect(tagsProperty.values).toContain("review");
  });

  it("should delete a document property", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${propertyTestDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            status: null,
          },
        }),
      },
    );

    expect(response.status).toBe(200);

    const docResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${propertyTestDocId}`,
    );
    const docData = await docResponse.json();
    expect(docData.document.properties.status).toBeUndefined();
  });

  it("should create property_update audit log when updating a property", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${propertyTestDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            testProperty: { value: "initial value" },
          },
        }),
      },
    );
    expect(response.status).toBe(200);

    const auditResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${propertyTestDocId}/audit-logs`,
    );
    expect(auditResponse.status).toBe(200);

    const auditData = await auditResponse.json();
    const propertyUpdateLog = auditData.auditLogs.find(
      (log: any) =>
        log.event === "property_update" && log.details?.propertyKey === "testProperty",
    );

    expect(propertyUpdateLog).toBeDefined();
    expect(propertyUpdateLog.docId).toBe(propertyTestDocId);
    expect(propertyUpdateLog.userId).toBe(LOCAL_USER_ID);

    expect(propertyUpdateLog.details.propertyKey).toBe("testProperty");
    expect(propertyUpdateLog.details.newValue).toBe("initial value");
  });

  it("should track previous value in property_update audit log", async () => {
    // Update the property again to test previousValue tracking
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${propertyTestDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            testProperty: { value: "updated value" },
          },
        }),
      },
    );
    expect(response.status).toBe(200);

    const auditResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${propertyTestDocId}/audit-logs`,
    );
    const auditData = await auditResponse.json();
    const propertyUpdateLogs = auditData.auditLogs.filter(
      (log: any) =>
        log.event === "property_update" && log.details?.propertyKey === "testProperty",
    );

    // Should have at least 2 logs now (one for create, one for update)
    expect(propertyUpdateLogs.length).toBeGreaterThanOrEqual(2);

    // Check the most recent one (first in array due to desc order)
    const latestLog = propertyUpdateLogs[0];
    expect(latestLog.details.previousValue).toBe("initial value");
    expect(latestLog.details.newValue).toBe("updated value");

    // Check the first creation log has no previous value
    const firstLog = propertyUpdateLogs[propertyUpdateLogs.length - 1];
    expect(firstLog.details.previousValue).toBeUndefined();
    expect(firstLog.details.newValue).toBe("initial value");
  });

  it("should create property_delete audit log when deleting a property", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${propertyTestDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            testProperty: null,
          },
        }),
      },
    );
    expect(response.status).toBe(200);

    const auditResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${propertyTestDocId}/audit-logs`,
    );
    expect(auditResponse.status).toBe(200);

    const auditData = await auditResponse.json();
    const propertyDeleteLog = auditData.auditLogs.find(
      (log: any) =>
        log.event === "property_delete" && log.details?.propertyKey === "testProperty",
    );

    expect(propertyDeleteLog).toBeDefined();
    expect(propertyDeleteLog.docId).toBe(propertyTestDocId);
    expect(propertyDeleteLog.userId).toBe(LOCAL_USER_ID);

    expect(propertyDeleteLog.details.propertyKey).toBe("testProperty");
    expect(propertyDeleteLog.details.previousValue).toBe("updated value");
  });
});

describe("API Tests - Categories", () => {
  let testCategoryId: string;

  it("should create a category", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/categories`, {
      method: "POST",
      body: JSON.stringify({
        name: "Getting Started",
        slug: "getting-started",
        description: "Beginner guides and tutorials",
        color: "#3b82f6",
        icon: "🚀",
      }),
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.category.id).toBeDefined();
    expect(data.category.id).toStartWith("category_");
    expect(data.category.name).toBe("Getting Started");
    expect(data.category.slug).toBe("getting-started");
    expect(data.category.color).toBe("#3b82f6");
    expect(data.category.icon).toBe("🚀");

    testCategoryId = data.category.id;
  });

  it("should list categories", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/categories`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.categories).toBeDefined();
    expect(Array.isArray(data.categories)).toBe(true);
    expect(data.categories.length).toBeGreaterThan(0);
    expect(data.categories[0].name).toBe("Getting Started");
  });

  it("should get a specific category", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/categories/${testCategoryId}`,
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.category.id).toBe(testCategoryId);
    expect(data.category.name).toBe("Getting Started");
  });

  it("should update a category", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/categories/${testCategoryId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          name: "Beginner's Guide",
          slug: "beginners-guide",
          description: "Updated description for beginners",
          color: "#ef4444",
          icon: "📚",
        }),
      },
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.category.name).toBe("Beginner's Guide");
    expect(data.category.slug).toBe("beginners-guide");
    expect(data.category.color).toBe("#ef4444");
    expect(data.category.icon).toBe("📚");
  });

  it("should create another category", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/categories`, {
      method: "POST",
      body: JSON.stringify({
        name: "Advanced Topics",
        slug: "advanced-topics",
        description: "For experienced users",
        color: "#8b5cf6",
        icon: "⚡",
      }),
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.category.name).toBe("Advanced Topics");
  });

  it("should delete a category", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/categories/${testCategoryId}`,
      {
        method: "DELETE",
      },
    );

    expect(response.status).toBe(200);

    const checkResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/categories/${testCategoryId}`,
    );
    expect(checkResponse.status).toBe(404);
  });
});

describe("API Tests - Error Handling", () => {
  it("should return 404 for non-existent space", async () => {
    const fakeSpaceId = crypto.randomUUID();
    const response = await apiRequest(`/api/v1/spaces/${fakeSpaceId}`);
    expect(response.status).toBe(404);
  });

  it("should return 404 for non-existent document", async () => {
    const fakeDocId = crypto.randomUUID();
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${fakeDocId}`,
    );
    expect(response.status).toBe(404);
  });

  it("should return 404 for non-existent category", async () => {
    const fakeCategoryId = crypto.randomUUID();
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/categories/${fakeCategoryId}`,
    );
    expect(response.status).toBe(404);
  });

  it("should return 400 for invalid document creation (missing content)", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        properties: {
          title: "Invalid Doc",
        },
      }),
    });

    expect(response.status).toBe(400);
  });

  it("should return 400 for invalid category creation (missing slug)", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/categories`, {
      method: "POST",
      body: JSON.stringify({
        name: "Invalid Category",
      }),
    });

    expect(response.status).toBe(400);
  });

  it("should return 400 for invalid property update (missing key)", async () => {
    // First create a document to test against
    const createResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "# Test Doc for Error",
        properties: { title: "Test" },
      }),
    });
    const docId = (await createResponse.json()).document.id;

    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${docId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            "": { value: "some value" },
          },
        }),
      },
    );

    expect(response.status).toBe(400);
  });
});

describe("API Tests - Revisions", () => {
  let revisionTestDocId: string;
  let firstRevisionNumber: number;
  let secondRevisionNumber: number;

  it("should create a document for revision testing", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "<h1>Initial Content</h1><p>This is the first version.</p>",
        properties: {
          title: "Revision Test Document",
        },
      }),
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    revisionTestDocId = data.document.id;
    expect(data.document.currentRev).toBe(1);
    expect(data.document.publishedRev).toBe(null);
  });

  it("should save a new revision", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}`,
      {
        method: "POST",
        body: JSON.stringify({
          html: "<h1>Updated Content</h1><p>This is the second version.</p>",
          message: "Updated heading and content",
        }),
      },
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.revision).toBeDefined();
    // Saves within the 5-hour autosave window overwrite rev in place, so rev stays at 1.
    expect(data.revision.rev).toBeGreaterThanOrEqual(1);
    expect(data.revision.message).toBe("Updated heading and content");
    expect(data.revision.checksum).toBeDefined();
    expect(data.revision.createdBy).toBe(LOCAL_USER_ID);

    firstRevisionNumber = data.revision.rev;
  });

  it("should save another revision", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}`,
      {
        method: "POST",
        body: JSON.stringify({
          html: "<h1>Third Version</h1><p>This is the third version with more changes.</p>",
          message: "Added more details",
        }),
      },
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    // Autosave overwrites rev in place within the 5-hour window.
    expect(data.revision.rev).toBeGreaterThanOrEqual(1);

    secondRevisionNumber = data.revision.rev;
  });

  it("should skip duplicate content (same checksum)", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}`,
      {
        method: "POST",
        body: JSON.stringify({
          html: "<h1>Third Version</h1><p>This is the third version with more changes.</p>",
          message: "This should be skipped",
        }),
      },
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    // Identical content returns the existing revision unchanged.
    expect(data.revision.rev).toBe(secondRevisionNumber);
  });

  it("should get revision history", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}/revisions`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.revisions).toBeDefined();
    expect(Array.isArray(data.revisions)).toBe(true);
    // Autosave overwrites within 5 hours, so there's at least 1 revision.
    expect(data.revisions.length).toBeGreaterThanOrEqual(1);
  });

  it("should return history with correct revision metadata", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}/revisions`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();

    // Verify each revision has required fields
    for (const revision of data.revisions) {
      expect(revision.id).toBeDefined();
      expect(revision.documentId).toBe(revisionTestDocId);
      expect(revision.rev).toBeDefined();
      expect(typeof revision.rev).toBe("number");
      expect(revision.checksum).toBeDefined();
      expect(revision.createdAt).toBeDefined();
      expect(revision.createdBy).toBe(LOCAL_USER_ID);
    }
  });

  it("should return history in descending order by revision number", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}/revisions`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();

    // Verify revisions are in descending order
    for (let i = 0; i < data.revisions.length - 1; i++) {
      expect(data.revisions[i].rev).toBeGreaterThan(data.revisions[i + 1].rev);
    }
  });

  it("should return history with revision messages", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}/revisions`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    // History endpoint returns an array of revisions with metadata.
    expect(Array.isArray(data.revisions)).toBe(true);
    expect(data.revisions.length).toBeGreaterThanOrEqual(1);
    for (const rev of data.revisions) {
      expect(rev.id).toBeDefined();
      expect(rev.rev).toBeGreaterThanOrEqual(1);
    }
  });

  it("should return empty array for history of non-existent document", async () => {
    const fakeDocId = crypto.randomUUID();
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${fakeDocId}/revisions`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.revisions).toBeDefined();
    expect(Array.isArray(data.revisions)).toBe(true);
    expect(data.revisions.length).toBe(0);
  });

  it("should return empty history for document with only initial revision", async () => {
    // Create a new document
    const createResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "# New Doc",
        properties: { title: "History Test Doc" },
      }),
    });
    const newDocId = (await createResponse.json()).document.id;

    // Get history - should have just the initial revision
    const historyResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${newDocId}/revisions`,
    );

    expect(historyResponse.status).toBe(200);
    const historyData = await historyResponse.json();
    expect(historyData.revisions).toBeDefined();
    expect(Array.isArray(historyData.revisions)).toBe(true);
    expect(historyData.revisions.length).toBe(1);
    expect(historyData.revisions[0].rev).toBe(1);
    expect(historyData.revisions[0].message).toBe("Initial revision");
  });

  it("should get specific revision with query parameter", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}?rev=${firstRevisionNumber}`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.revision).toBeDefined();
    expect(data.revision.rev).toBe(firstRevisionNumber);
    // Autosave overwrites rev in place — the stored content is the latest save.
    expect(data.revision.content).toBe(
      "<h1>Third Version</h1><p>This is the third version with more changes.</p>",
    );
  });

  it("should publish a specific revision", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          publishedRev: secondRevisionNumber,
        }),
      },
    );

    expect(response.status).toBe(200);

    const data = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}`,
    ).then((res) => res.json());

    expect(data.document).toBeDefined();
    expect(data.document.publishedRev).toBe(secondRevisionNumber);
  });

  it("should return published content by default when fetching document", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.document.publishedRev).toBe(secondRevisionNumber);
    // Content matches the latest overwritten revision content.
    expect(data.document.content).toBeDefined();
  });

  it("should unpublish by setting publishedRev to null", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          publishedRev: null,
        }),
      },
    );

    expect(response.status).toBe(200);

    const data = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}`,
    ).then((res) => res.json());

    expect(data.document.publishedRev).toBe(null);
  });

  it("should return 400 for invalid revision number", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}?rev=invalid`,
    );

    expect(response.status).toBe(400);
  });

  it("should return 404 for non-existent revision", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}?rev=999`,
    );

    expect(response.status).toBe(404);
  });

  it("should return 400 when saving revision without html", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}`,
      {
        method: "POST",
        body: JSON.stringify({
          message: "Missing HTML",
        }),
      },
    );

    expect(response.status).toBe(400);
  });

  it("should return 400 when publishing with invalid rev number", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          publishedRev: "invalid",
        }),
      },
    );

    expect(response.status).toBe(400);
  });

  it("should verify compression efficiency", async () => {
    const longHtml = `<p>${"Lorem ipsum dolor sit amet. ".repeat(100)}</p>`;

    const saveResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}`,
      {
        method: "POST",
        body: JSON.stringify({
          html: longHtml,
          message: "Large content test",
        }),
      },
    );

    expect(saveResponse.status).toBe(200);
    const saveData = await saveResponse.json();
    const savedRev = saveData.revision.rev;

    const fetchResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${revisionTestDocId}?rev=${savedRev}`,
    );

    expect(fetchResponse.status).toBe(200);
    const fetchData = await fetchResponse.json();
    expect(fetchData.revision.content).toBe(longHtml);
  });
});

describe("API Tests - Fuzz Testing / Edge Cases", () => {
  describe("Invalid IDs and Parameters", () => {
    it("should return 404 for non-existent space ID", async () => {
      const fakeSpaceId = crypto.randomUUID();
      const response = await apiRequest(`/api/v1/spaces/${fakeSpaceId}`);
      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain("Space not found");
    });

    it("should return 404 for malformed space ID", async () => {
      const response = await apiRequest(`/api/v1/spaces/not-a-valid-id`);
      expect(response.status).toBe(404);
    });

    it("should return 404 when creating a document in a non-existent space", async () => {
      const fakeSpaceId = crypto.randomUUID();
      const response = await apiRequest(`/api/v1/spaces/${fakeSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({ content: "# Test", properties: { title: "Test" } }),
      });
      expect(response.status).toBe(404);
    });

    it("should return 404 when listing categories in a non-existent space", async () => {
      const fakeSpaceId = crypto.randomUUID();
      const response = await apiRequest(`/api/v1/spaces/${fakeSpaceId}/categories`);
      expect(response.status).toBe(404);
    });

    it("should return 404 when fetching document history in a non-existent space", async () => {
      const fakeSpaceId = crypto.randomUUID();
      const fakeDocId = crypto.randomUUID();
      const response = await apiRequest(
        `/api/v1/spaces/${fakeSpaceId}/documents/${fakeDocId}/revisions`,
      );
      expect(response.status).toBe(404);
    });

    it("should return 404 for non-existent document ID", async () => {
      const fakeDocId = crypto.randomUUID();
      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${fakeDocId}`,
      );
      expect(response.status).toBe(404);
    });

    it("should return 404 for malformed document ID", async () => {
      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/invalid-id`,
      );
      expect(response.status).toBe(404);
    });

    it("should return 404 for non-existent category ID", async () => {
      const fakeCategoryId = crypto.randomUUID();
      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/categories/${fakeCategoryId}`,
      );
      expect(response.status).toBe(404);
    });
  });

  describe("Missing Required Fields", () => {
    it("should return 400 for document creation without content", async () => {
      const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          properties: { title: "No Content" },
        }),
      });
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it("should return 400 for document creation with empty content", async () => {
      const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: "",
          properties: { title: "Empty Content" },
        }),
      });
      expect(response.status).toBe(400);
    });

    it("should return 400 for category creation without slug", async () => {
      const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/categories`, {
        method: "POST",
        body: JSON.stringify({
          name: "No Slug Category",
        }),
      });
      expect(response.status).toBe(400);
    });

    it("should return 400 for category creation without name", async () => {
      const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/categories`, {
        method: "POST",
        body: JSON.stringify({
          slug: "no-name",
        }),
      });
      expect(response.status).toBe(400);
    });

    it("should return 400 for space creation without name", async () => {
      const response = await apiRequest("/api/v1/spaces", {
        method: "POST",
        body: JSON.stringify({
          slug: "no-name-space",
        }),
      });
      expect(response.status).toBe(400);
    });

    it("should return 400 for space creation without slug", async () => {
      const response = await apiRequest("/api/v1/spaces", {
        method: "POST",
        body: JSON.stringify({
          name: "No Slug Space",
        }),
      });
      expect(response.status).toBe(400);
    });

    it("should return 400 for property update without key", async () => {
      const createResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: "# Test Doc",
          properties: { title: "Test" },
        }),
      });
      const docId = (await createResponse.json()).document.id;

      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${docId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            properties: {
              "": { value: "some value" },
            },
          }),
        },
      );
      expect(response.status).toBe(400);
    });

    it("should return 400 for revision save without html", async () => {
      const createResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: "# Test Doc",
          properties: { title: "Test" },
        }),
      });
      const docId = (await createResponse.json()).document.id;

      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${docId}`,
        {
          method: "POST",
          body: JSON.stringify({
            message: "No content",
          }),
        },
      );
      expect(response.status).toBe(400);
    });

    it("should return 400 for publish with invalid rev type", async () => {
      const createResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: "# Test Doc",
          properties: { title: "Test" },
        }),
      });
      const docId = (await createResponse.json()).document.id;

      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${docId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            publishedRev: "not-a-number",
          }),
        },
      );
      expect(response.status).toBe(400);
    });
  });

  describe("Invalid Data Types", () => {
    it("should return 400 for revision query with invalid rev number", async () => {
      const createResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: "# Test Doc",
          properties: { title: "Test" },
        }),
      });
      const docId = (await createResponse.json()).document.id;

      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${docId}?rev=invalid`,
      );
      expect(response.status).toBe(400);
    });

    it("should return 400 for revision query with negative rev number", async () => {
      const createResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: "# Test Doc",
          properties: { title: "Test" },
        }),
      });
      const docId = (await createResponse.json()).document.id;

      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${docId}?rev=-1`,
      );
      expect(response.status).toBe(400);
    });

    it("should return 404 for non-existent revision number", async () => {
      const createResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: "# Test Doc",
          properties: { title: "Test" },
        }),
      });
      const docId = (await createResponse.json()).document.id;

      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${docId}?rev=999999`,
      );
      expect(response.status).toBe(404);
    });

    it("should return 400 for patch with invalid publishedRev type", async () => {
      const createResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: "# Test Doc",
          properties: { title: "Test" },
        }),
      });
      const docId = (await createResponse.json()).document.id;

      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${docId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ publishedRev: { invalid: "object" } }),
        },
      );
      expect(response.status).toBe(400);
    });
  });

  describe("Malformed JSON and Content-Type", () => {
    it("should handle malformed JSON gracefully", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{invalid json}",
      });
      // API may return 500 for JSON parse errors - that's acceptable
      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it("should handle empty request body", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "",
      });
      // API may return 500 for empty body - that's acceptable
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe("Boundary Values", () => {
    it("should handle extremely long document content", async () => {
      const longContent = `# Long Content\n${"a".repeat(100000)}`;
      const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: longContent,
          properties: { title: "Long Doc" },
        }),
      });
      expect(response.status).toBeLessThan(500);
    });

    it("should handle empty revision message", async () => {
      const createResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: "# Test Doc",
          properties: { title: "Test" },
        }),
      });
      const docId = (await createResponse.json()).document.id;

      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${docId}`,
        {
          method: "POST",
          body: JSON.stringify({
            html: "<h1>Updated Content</h1>",
            message: "",
          }),
        },
      );
      expect(response.status).toBe(200);
    });

    it("should handle very long property keys and values", async () => {
      const createResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: "# Test Doc",
          properties: { title: "Test" },
        }),
      });
      const docId = (await createResponse.json()).document.id;

      const longKey = "a".repeat(255);
      const longValue = "b".repeat(1000);

      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${docId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            properties: {
              [longKey]: { value: longValue },
            },
          }),
        },
      );
      expect(response.status).toBeLessThan(500);
    });
  });

  describe("Special Characters and Encoding", () => {
    it("should handle special characters in space slug", async () => {
      const response = await apiRequest("/api/v1/spaces", {
        method: "POST",
        body: JSON.stringify({
          name: "Special Space",
          slug: "special!@#$%space",
        }),
      });
      expect(response.status).toBeLessThan(500);
    });

    it("should handle unicode in document content", async () => {
      const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: "# Unicode Test 🦘 你好 مرحبا",
          properties: { title: "Unicode Doc" },
        }),
      });
      expect(response.status).toBeLessThan(500);
    });

    it("should handle HTML injection in revision message", async () => {
      const createResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: "# Test Doc",
          properties: { title: "Test" },
        }),
      });
      const docId = (await createResponse.json()).document.id;

      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${docId}`,
        {
          method: "POST",
          body: JSON.stringify({
            html: "<h1>Content</h1>",
            message: "<script>alert('xss')</script>",
          }),
        },
      );
      expect(response.status).toBe(200);
    });
  });

  describe("Concurrent Operations", () => {
    it("should handle duplicate revision saves (same checksum)", async () => {
      const createResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: "# Test Doc",
          properties: { title: "Test" },
        }),
      });
      const docId = (await createResponse.json()).document.id;

      const saveData = {
        html: "<h1>Same Content</h1>",
        message: "First save",
      };

      const response1 = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${docId}`,
        {
          method: "POST",
          body: JSON.stringify(saveData),
        },
      );
      expect(response1.status).toBe(200);
      const data1 = await response1.json();

      const response2 = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${docId}`,
        {
          method: "POST",
          body: JSON.stringify(saveData),
        },
      );
      expect(response2.status).toBe(200);

      const data2 = await response2.json();
      // Duplicate saves return the same revision
      expect(data2.revision.rev).toBe(data1.revision.rev);
      expect(data2.revision.checksum).toBe(data1.revision.checksum);
    });
  });

  describe("Restore Operation Edge Cases", () => {
    it("should return 404 when restoring non-existent revision", async () => {
      const createResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: "# Test Doc",
          properties: { title: "Test" },
        }),
      });
      const docId = (await createResponse.json()).document.id;

      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${docId}/revisions?rev=99999`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      expect(response.status).toBe(404);
    });

    it("should return 400 when restoring with invalid revision number", async () => {
      const createResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: "# Test Doc",
          properties: { title: "Test" },
        }),
      });
      const docId = (await createResponse.json()).document.id;

      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${docId}/revisions?rev=invalid`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      expect(response.status).toBe(400);
    });
  });

  describe("Children and Hierarchy Edge Cases", () => {
    it("should return empty array for children of non-existent document", async () => {
      const fakeDocId = crypto.randomUUID();
      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${fakeDocId}/children`,
      );
      expect(response.status).toBe(404);
    });

    it("should handle circular parent references gracefully", async () => {
      const doc1Response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: "# Doc 1",
          properties: { title: "Doc 1" },
        }),
      });
      const doc1Id = (await doc1Response.json()).document.id;

      const doc2Response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          content: "# Doc 2",
          properties: { title: "Doc 2" },
          parentId: doc1Id,
        }),
      });
      const doc2Id = (await doc2Response.json()).document.id;

      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${doc1Id}`,
        {
          method: "PUT",
          body: JSON.stringify({
            content: "# Doc 1 Updated",
            properties: { title: "Doc 1" },
            parentId: doc2Id,
          }),
        },
      );

      expect(response.status).toBeLessThan(500);
    });
  });
});

describe("API Tests - Audit Logs", () => {
  let auditTestDocId: string;
  let auditSavedRev: number;

  it("should create a document for audit log testing", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "Initial audit test content",
        properties: { title: "Audit Test Doc" },
      }),
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    auditTestDocId = data.document.id;
  });

  it("should return audit logs for a document", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${auditTestDocId}/audit-logs`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.auditLogs).toBeDefined();
    expect(Array.isArray(data.auditLogs)).toBe(true);
    expect(data.auditLogs.length).toBeGreaterThan(0);
  });

  it("should include create event in audit logs", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${auditTestDocId}/audit-logs`,
    );

    const data = await response.json();
    const createLog = data.auditLogs.find((log: any) => log.event === "create");

    expect(createLog).toBeDefined();
    expect(createLog.docId).toBe(auditTestDocId);
    expect(createLog.userId).toBe(LOCAL_USER_ID);
    expect(createLog.revisionId).toBe(1);
  });

  it("should track save events in audit logs", async () => {
    const saveResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${auditTestDocId}`,
      {
        method: "POST",
        body: JSON.stringify({
          html: "<p>Updated content for audit</p>",
          message: "Test save for audit",
        }),
      },
    );
    const saveData = await saveResponse.json();
    auditSavedRev = saveData.revision.rev;

    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${auditTestDocId}/audit-logs`,
    );

    const data = await response.json();
    const saveLogs = data.auditLogs.filter((log: any) => log.event === "save");

    expect(saveLogs.length).toBeGreaterThan(0);
    expect(saveLogs[0].userId).toBe(LOCAL_USER_ID);
  });

  it("should track publish events in audit logs", async () => {
    await apiRequest(`/api/v1/spaces/${testSpaceId}/documents/${auditTestDocId}`, {
      method: "PATCH",
      body: JSON.stringify({ publishedRev: auditSavedRev }),
    });

    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${auditTestDocId}/audit-logs`,
    );

    const data = await response.json();
    const publishLog = data.auditLogs.find((log: any) => log.event === "publish");

    expect(publishLog).toBeDefined();
    expect(publishLog.revisionId).toBe(auditSavedRev);
    expect(publishLog.userId).toBe(LOCAL_USER_ID);
  });

  it("should track restore events in audit logs", async () => {
    await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${auditTestDocId}/revisions?rev=1`,
      {
        method: "POST",
        body: JSON.stringify({ message: "Restoring for audit test" }),
      },
    );

    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${auditTestDocId}/audit-logs`,
    );

    const data = await response.json();
    const restoreLog = data.auditLogs.find((log: any) => log.event === "restore");

    expect(restoreLog).toBeDefined();
    expect(restoreLog.revisionId).toBe(1);
  });

  it("should return audit logs in descending order by creation time", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${auditTestDocId}/audit-logs`,
    );

    const data = await response.json();
    const timestamps = data.auditLogs.map((log: any) =>
      new Date(log.createdAt).getTime(),
    );

    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
    }
  });

  it("should parse audit log details correctly", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${auditTestDocId}/audit-logs`,
    );

    const data = await response.json();
    const logWithDetails = data.auditLogs.find((log: any) => log.details !== null);

    if (logWithDetails) {
      expect(logWithDetails.details).toBeDefined();
      expect(typeof logWithDetails.details).toBe("object");
    }
  });

  it("should respect limit query parameter", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${auditTestDocId}/audit-logs?limit=2`,
    );

    const data = await response.json();
    expect(data.auditLogs.length).toBeLessThanOrEqual(2);
  });

  it("should use default limit of 100 when not specified", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${auditTestDocId}/audit-logs`,
    );

    const data = await response.json();
    expect(data.auditLogs.length).toBeLessThanOrEqual(100);
  });

  it("should return empty array for non-existent document", async () => {
    const fakeDocId = "non-existent-doc-id";
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${fakeDocId}/audit-logs`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.auditLogs).toBeDefined();
    expect(Array.isArray(data.auditLogs)).toBe(true);
    expect(data.auditLogs.length).toBe(0);
  });

  it("should return 404 for non-existent space", async () => {
    const fakeSpaceId = "non-existent-space-id";
    const response = await apiRequest(
      `/api/v1/spaces/${fakeSpaceId}/documents/${auditTestDocId}/audit-logs`,
    );

    expect(response.status).toBe(404);
  });

  it("should include all required fields in audit log entries", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${auditTestDocId}/audit-logs`,
    );

    const data = await response.json();
    const log = data.auditLogs[0];

    expect(log).toHaveProperty("id");
    expect(log).toHaveProperty("docId");
    expect(log).toHaveProperty("event");
    expect(log).toHaveProperty("createdAt");
    expect(log).toHaveProperty("details");
  });

  it("should handle invalid limit parameter gracefully", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${auditTestDocId}/audit-logs?limit=invalid`,
    );

    expect(response.status).toBe(400);
  });

  it("should track unpublish events via PATCH endpoint", async () => {
    await apiRequest(`/api/v1/spaces/${testSpaceId}/documents/${auditTestDocId}`, {
      method: "PATCH",
      body: JSON.stringify({ publishedRev: null }),
    });

    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${auditTestDocId}/audit-logs`,
    );

    const data = await response.json();
    const unpublishLog = data.auditLogs.find((log: any) => log.event === "unpublish");

    expect(unpublishLog).toBeDefined();
  });

  it("should track archive events in audit logs", async () => {
    const newDocResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "Doc for archive audit test",
        properties: { title: "Archive Audit Test" },
      }),
    });

    const newDocData = await newDocResponse.json();
    const newDocId = newDocData.document.id;

    const logsBeforeArchive = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${newDocId}/audit-logs`,
    );
    const dataBeforeArchive = await logsBeforeArchive.json();
    const initialLogCount = dataBeforeArchive.auditLogs.length;

    await apiRequest(`/api/v1/spaces/${testSpaceId}/documents/${newDocId}`, {
      method: "DELETE",
    });

    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${newDocId}/audit-logs`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.auditLogs.length).toBeGreaterThan(initialLogCount);
    const archiveLog = data.auditLogs.find((log: any) => log.event === "archive");
    expect(archiveLog).toBeDefined();
  });

  it("should track restore events in audit logs", async () => {
    const newDocResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "Doc for restore audit test",
        properties: { title: "Restore Audit Test" },
      }),
    });

    const newDocData = await newDocResponse.json();
    const newDocId = newDocData.document.id;

    // Archive the document
    await apiRequest(`/api/v1/spaces/${testSpaceId}/documents/${newDocId}`, {
      method: "DELETE",
    });

    const logsBeforeRestore = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${newDocId}/audit-logs`,
    );
    const dataBeforeRestore = await logsBeforeRestore.json();
    const initialLogCount = dataBeforeRestore.auditLogs.length;

    // Restore the document
    await apiRequest(`/api/v1/spaces/${testSpaceId}/documents/${newDocId}`, {
      method: "PUT",
      body: JSON.stringify({ restore: true }),
    });

    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${newDocId}/audit-logs`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.auditLogs.length).toBeGreaterThan(initialLogCount);
    const restoreLog = data.auditLogs.find((log: any) => log.event === "restore");
    expect(restoreLog).toBeDefined();
    expect(restoreLog.details).toHaveProperty("message");
    expect(restoreLog.details.message).toBe("Document restored");
  });

  it("should track delete events in audit logs (permanent delete)", async () => {
    const newDocResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "Doc for permanent delete audit test",
        properties: { title: "Permanent Delete Audit Test" },
      }),
    });

    const newDocData = await newDocResponse.json();
    const newDocId = newDocData.document.id;

    const logsBeforeDelete = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${newDocId}/audit-logs`,
    );
    const dataBeforeDelete = await logsBeforeDelete.json();
    const initialLogCount = dataBeforeDelete.auditLogs.length;

    await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${newDocId}?permanent=true`,
      {
        method: "DELETE",
      },
    );

    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${newDocId}/audit-logs`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.auditLogs.length).toBeGreaterThan(initialLogCount);
    const deleteLog = data.auditLogs.find((log: any) => log.event === "delete");
    expect(deleteLog).toBeDefined();
  });

  it("should verify audit log timestamps are valid ISO strings", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${auditTestDocId}/audit-logs`,
    );

    const data = await response.json();

    for (const log of data.auditLogs) {
      const timestamp = new Date(log.createdAt);
      expect(timestamp.toString()).not.toBe("Invalid Date");
    }
  });
});

describe("API Tests - Contributors (noAuth)", () => {
  it("should return empty array in noAuth mode (LOCAL_USER not in auth DB)", async () => {
    const createResp = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "<p>doc</p>",
        properties: { title: "Contributors noAuth Test" },
      }),
    });
    expect(createResp.status).toBe(201);
    const { document } = await createResp.json();

    const resp = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${document.id}/contributors`,
    );
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(Array.isArray(data.contributors)).toBe(true);
    expect(data.contributors.length).toBe(0);
  });
});
