import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { LOCAL_USER_ID } from "#noAuth";
import {
  createApiRequest,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7480;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let testSpaceId: string;
let readonlyTestDocId: string;

beforeAll(async () => {
  try {
    serverProcess = startTestServer(PORT, {
      VEKTOR_NO_AUTH: "1",
      VEKTOR_IN_MEMORY_DB: "1",
      VEKTOR_API_ONLY: "1",
    });

    await waitForServer(BASE_URL);

    // Create test space
    const spaceResponse = await apiRequest("/api/v1/spaces", {
      method: "POST",
      body: JSON.stringify({
        name: "Readonly Test Space",
        slug: "readonly-test-space",
      }),
    });

    if (!spaceResponse.ok) {
      const errorText = await spaceResponse.text();
      throw new Error(`Failed to create space: ${spaceResponse.status} ${errorText}`);
    }

    const spaceData = await spaceResponse.json();
    testSpaceId = spaceData.space.id;

    // Create test document
    const docResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "# Readonly Test Document\n\nInitial content for testing.",
        properties: {
          title: "Readonly Test Doc",
        },
      }),
    });

    if (!docResponse.ok) {
      const errorText = await docResponse.text();
      throw new Error(`Failed to create document: ${docResponse.status} ${errorText}`);
    }

    const docData = await docResponse.json();
    readonlyTestDocId = docData.document.id;
  } catch (error) {
    console.error("Setup failed:", error);
    throw error;
  }
});

afterAll(() => {
  serverProcess?.kill();
});

describe("API Tests - Readonly Documents", () => {
  it("should set a document as readonly via PATCH endpoint", async () => {
    if (!readonlyTestDocId) {
      throw new Error("Readonly document ID not found");
    }

    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          readonly: true,
        }),
      },
    );

    expect(response.status).toBe(200);

    const data = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
    ).then((res) => res.json());

    expect(data.document.readonly).toBe(true);
  });

  it("should retrieve readonly status when fetching document", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.document.readonly).toBe(true);
  });

  it("should prevent updating content on readonly document via PUT", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          content: "# Attempt to Update\n\nThis should fail.",
        }),
      },
    );

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toContain("readonly");
  });

  it("should prevent saving revisions on readonly document", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
      {
        method: "POST",
        body: JSON.stringify({
          html: "<h1>Attempted Update</h1><p>This should fail.</p>",
          message: "Trying to save readonly doc",
        }),
      },
    );

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toContain("readonly");
  });

  it("should create lock audit log entry when setting readonly to true", async () => {
    // Create a new document for this test
    const docResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "# Audit Test Doc\n\nFor testing audit logs.",
        properties: {
          title: "Audit Test",
        },
      }),
    });

    const docData = await docResponse.json();
    const newDocId = docData.document.id;

    // Set it as readonly
    await apiRequest(`/api/v1/spaces/${testSpaceId}/documents/${newDocId}`, {
      method: "PATCH",
      body: JSON.stringify({
        readonly: true,
      }),
    });

    // Check audit logs
    const auditResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${newDocId}/audit-logs`,
    );

    expect(auditResponse.status).toBe(200);
    const auditData = await auditResponse.json();
    const lockLog = auditData.auditLogs.find((log: any) => log.event === "lock");

    expect(lockLog).toBeDefined();
    expect(lockLog.userId).toBe(LOCAL_USER_ID);
    expect(lockLog.details.message).toContain("readonly");
  });

  it("should remove readonly status when setting to false", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          readonly: false,
        }),
      },
    );

    expect(response.status).toBe(200);

    const data = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
    ).then((res) => res.json());

    expect(data.document.readonly).toBe(false);
  });

  it("should create unlock audit log entry when setting readonly to false", async () => {
    const auditResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}/audit-logs`,
    );

    expect(auditResponse.status).toBe(200);
    const auditData = await auditResponse.json();
    const unlockLog = auditData.auditLogs.find((log: any) => log.event === "unlock");

    expect(unlockLog).toBeDefined();
    expect(unlockLog.userId).toBe(LOCAL_USER_ID);
    expect(unlockLog.details.message).toContain("readonly");
  });

  it("should allow updates after removing readonly status", async () => {
    const updatedContent = "# Updated After Unlock\n\nThis should work now.";
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          content: updatedContent,
        }),
      },
    );

    expect(response.status).toBe(200);

    // The PUT response omits `content` (see the handler); confirm the update
    // persisted via a subsequent GET instead.
    const fetched = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
    );
    const fetchedData = await fetched.json();
    expect(fetchedData.document.content).toBe(updatedContent);
  });

  it("should allow saving revisions after removing readonly status", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
      {
        method: "POST",
        body: JSON.stringify({
          html: "<h1>Updated After Unlock</h1><p>This should work.</p>",
          message: "Save after unlock",
        }),
      },
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.revision).toBeDefined();
    expect(data.revision.message).toBe("Save after unlock");
  });

  it("should return 400 for invalid readonly value (non-boolean)", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          readonly: "true", // String instead of boolean
        }),
      },
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("boolean");
  });

  it("should handle readonly undefined (no change)", async () => {
    // First set to readonly
    await apiRequest(`/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`, {
      method: "PATCH",
      body: JSON.stringify({
        readonly: true,
      }),
    });

    // Get current state
    const beforeResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
    );
    const beforeData = await beforeResponse.json();

    // PATCH without readonly field
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          parentId: null,
        }),
      },
    );

    expect(response.status).toBe(200);

    const data = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
    ).then((res) => res.json());

    // Should remain readonly
    expect(data.document.readonly).toBe(beforeData.document.readonly);
  });

  it("should list documents with readonly field", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data.documents)).toBe(true);

    // Find our test document
    const testDoc = data.documents.find((doc: any) => doc.id === readonlyTestDocId);
    expect(testDoc).toBeDefined();
    expect(typeof testDoc.readonly).toBe("boolean");
  });

  it("should allow toggling readonly status multiple times", async () => {
    // Set to readonly
    let response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          readonly: true,
        }),
      },
    );
    expect(response.status).toBe(200);

    let data = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
    ).then((res) => res.json());

    expect(data.document.readonly).toBe(true);

    // Set to not readonly
    response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          readonly: false,
        }),
      },
    );
    expect(response.status).toBe(200);

    data = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
    ).then((res) => res.json());

    expect(data.document.readonly).toBe(false);

    // Set back to readonly
    response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          readonly: true,
        }),
      },
    );
    expect(response.status).toBe(200);

    data = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
    ).then((res) => res.json());

    expect(data.document.readonly).toBe(true);
  });

  it("should create new documents with readonly defaulted to false", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "# New Document\n\nDefault readonly test.",
        properties: {
          title: "New Doc",
        },
      }),
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.document.readonly).toBe(false);
  });

  it("should prevent content updates but allow metadata changes on readonly documents", async () => {
    // Create a new document
    const docResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "# Metadata Test\n\nFor testing metadata changes.",
        properties: {
          title: "Metadata Test",
        },
      }),
    });
    const docData = await docResponse.json();
    const newDocId = docData.document.id;

    // Set as readonly
    await apiRequest(`/api/v1/spaces/${testSpaceId}/documents/${newDocId}`, {
      method: "PATCH",
      body: JSON.stringify({
        readonly: true,
      }),
    });

    // Try to update content (should fail)
    const contentResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${newDocId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          content: "# Updated Content",
        }),
      },
    );
    expect(contentResponse.status).toBe(403);

    // Update parent (metadata change - should succeed)
    const metadataResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${newDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          parentId: null,
        }),
      },
    );
    expect(metadataResponse.status).toBe(200);
  });

  it("should include readonly status in search results", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/search?q=readonly`);

    expect(response.status).toBe(200);
    const data = await response.json();

    if (data.results.length > 0) {
      const result = data.results[0];
      expect(typeof result.readonly).toBe("boolean");
    }
  });

  it("should maintain readonly status when publishing revisions", async () => {
    // Create a document and set as readonly
    const docResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "# Publish Test\n\nFor testing publish with readonly.",
        properties: {
          title: "Publish Test",
        },
      }),
    });
    const docData = await docResponse.json();
    const newDocId = docData.document.id;

    await apiRequest(`/api/v1/spaces/${testSpaceId}/documents/${newDocId}`, {
      method: "PATCH",
      body: JSON.stringify({
        readonly: true,
      }),
    });

    // Publish a revision (metadata operation, should work)
    const publishResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${newDocId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          publishedRev: 1,
        }),
      },
    );

    expect(publishResponse.status).toBe(200);

    const publishData = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${readonlyTestDocId}`,
    ).then((res) => res.json());

    // Readonly status should be maintained
    expect(publishData.document.readonly).toBe(true);
  });
});

describe("API Tests - Readonly Edge Cases", () => {
  it("should handle concurrent readonly status changes", async () => {
    // Create test document
    const docResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "# Concurrent Test\n\nFor testing concurrent changes.",
        properties: {
          title: "Concurrent Test",
        },
      }),
    });
    const docData = await docResponse.json();
    const newDocId = docData.document.id;

    // Simulate concurrent requests
    const results = await Promise.all([
      apiRequest(`/api/v1/spaces/${testSpaceId}/documents/${newDocId}`, {
        method: "PATCH",
        body: JSON.stringify({ readonly: true }),
      }),
      apiRequest(`/api/v1/spaces/${testSpaceId}/documents/${newDocId}`, {
        method: "PATCH",
        body: JSON.stringify({ readonly: false }),
      }),
    ]);

    // Both should succeed (last write wins)
    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);

    // Check final state
    const finalResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${newDocId}`,
    );
    const finalData = await finalResponse.json();
    expect(typeof finalData.document.readonly).toBe("boolean");
  });

  it("should preserve readonly status through document retrieval operations", async () => {
    // Create and set readonly
    const docResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "# Persistence Test\n\nTesting readonly persistence.",
        properties: {
          title: "Persistence Test",
        },
      }),
    });
    const docData = await docResponse.json();
    const newDocId = docData.document.id;

    await apiRequest(`/api/v1/spaces/${testSpaceId}/documents/${newDocId}`, {
      method: "PATCH",
      body: JSON.stringify({ readonly: true }),
    });

    // Fetch multiple times
    for (let i = 0; i < 3; i++) {
      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${newDocId}`,
      );
      const data = await response.json();
      expect(data.document.readonly).toBe(true);
    }
  });

  it("should return consistent readonly value types across endpoints", async () => {
    const docResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content: "# Type Test\n\nTesting type consistency.",
        properties: {
          title: "Type Test",
        },
      }),
    });
    const docData = await docResponse.json();
    const newDocId = docData.document.id;

    // Check create response
    expect(typeof docData.document.readonly).toBe("boolean");

    // Check get response
    const getResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${newDocId}`,
    );
    const getData = await getResponse.json();
    expect(typeof getData.document.readonly).toBe("boolean");
  });
});
