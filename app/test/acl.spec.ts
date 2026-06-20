import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const PORT = 7484;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let serverProcess: ReturnType<typeof Bun.spawn>;

async function waitForServer(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/v1/spaces`);
      if (res.status < 500) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(100);
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

let testUser1: { id: string; email: string; name: string };
let testUser2: { id: string; email: string; name: string };
let testUser3: { id: string; email: string; name: string };
let session1Token: string;
let session2Token: string;
let session3Token: string;
let testSpaceId: string;
let testDocumentId: string;
let featuresTestSpaceId: string;
let featuresTestDocumentId: string;

async function createTestUser(name: string) {
  const testEmail = `test-acl-${Date.now()}-${Math.random()}@example.com`;
  const testPassword = "TestPassword123!";

  const response = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: testEmail,
      password: testPassword,
      name,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create test user: ${response.statusText}`);
  }

  const data = await response.json();
  const token = data.token;

  const cookies = response.headers.get("set-cookie");
  let sessionCookie = "";
  if (cookies) {
    const match = cookies.match(/vektor\.session_token=([^;]+)/);
    if (match) {
      sessionCookie = match[1];
    }
  }

  if (!sessionCookie) {
    sessionCookie = `${token}.${Buffer.from(token).toString("base64")}`;
  }

  return {
    userId: data.user.id,
    token: sessionCookie,
    email: testEmail,
    name: data.user.name,
  };
}

async function apiRequest(
  path: string,
  sessionToken: string,
  options: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (sessionToken) {
    headers.set("Cookie", `vektor.session_token=${sessionToken}`);
  }
  headers.set("Content-Type", "application/json");

  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });
}

beforeAll(async () => {
  serverProcess = Bun.spawn(["bun", "./src/server.ts", "--port", String(PORT)], {
    env: {
      ...process.env,
      VEKTOR_IN_MEMORY_DB: "1",
      VEKTOR_EMAIL_AUTH: "1",
      AUTH_SECRET: process.env.AUTH_SECRET ?? "acl-test-secret-do-not-use-in-production",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      VEKTOR_OTEL_ENABLED: "0",
    },
    stdout: "ignore",
    stderr: "ignore",
    cwd: import.meta.dir + "/..",
  });
  await waitForServer();

  try {
    // Create three test users
    const user1Data = await createTestUser("Test User 1");
    testUser1 = {
      id: user1Data.userId,
      email: user1Data.email,
      name: user1Data.name,
    };
    session1Token = user1Data.token;

    const user2Data = await createTestUser("Test User 2");
    testUser2 = {
      id: user2Data.userId,
      email: user2Data.email,
      name: user2Data.name,
    };
    session2Token = user2Data.token;

    const user3Data = await createTestUser("Test User 3");
    testUser3 = {
      id: user3Data.userId,
      email: user3Data.email,
      name: user3Data.name,
    };
    session3Token = user3Data.token;

    // Create a test space as user1
    const uniqueSlug = `acl-test-space-${Date.now()}`;
    const spaceResponse = await apiRequest("/api/v1/spaces", session1Token, {
      method: "POST",
      body: JSON.stringify({
        name: "ACL Test Space",
        slug: uniqueSlug,
      }),
    });

    if (!spaceResponse.ok) {
      const errorText = await spaceResponse.text();
      throw new Error(`Failed to create space (${spaceResponse.status}): ${errorText}`);
    }

    const spaceData = await spaceResponse.json();
    testSpaceId = spaceData.space.id;

    // Create a test document
    const docResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "# ACL Test Document\n\nThis is a test document.",
          properties: {
            title: "ACL Test Document",
          },
        }),
      },
    );

    const docData = await docResponse.json();
    testDocumentId = docData.document.id;

    console.log("ACL test setup complete");
  } catch (error) {
    console.error("Failed to setup ACL tests:", error);
    throw error;
  }
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

beforeAll(async () => {
  try {
    const uniqueSlug = `features-test-space-${Date.now()}`;
    const spaceResponse = await apiRequest("/api/v1/spaces", session1Token, {
      method: "POST",
      body: JSON.stringify({
        name: "Features Test Space",
        slug: uniqueSlug,
      }),
    });

    if (!spaceResponse.ok) {
      const errorText = await spaceResponse.text();
      throw new Error(
        `Failed to create features space (${spaceResponse.status}): ${errorText}`,
      );
    }

    const spaceData = await spaceResponse.json();
    featuresTestSpaceId = spaceData.space.id;

    await apiRequest(`/api/v1/spaces/${featuresTestSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "editor",
        userId: testUser2.id,
        action: "grant",
      }),
    });

    await apiRequest(`/api/v1/spaces/${featuresTestSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        userId: testUser3.id,
        action: "grant",
      }),
    });

    const docResponse = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          content:
            "# Features Test Document\n\nThis is a test document for feature permissions.",
          properties: { title: "Features Test Document" },
        }),
      },
    );

    const docData = await docResponse.json();
    featuresTestDocumentId = docData.document.id;
  } catch (error) {
    console.error("Failed to setup feature permissions tests:", error);
    throw error;
  }
});

describe("ACL API Tests - Space Members", () => {
  it("should list space members", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions?type=role`,
      session1Token,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    const members = data.permissions;
    expect(Array.isArray(members)).toBe(true);
    expect(members.length).toBeGreaterThan(0);

    // Owner should be in the list
    const owner = members.find((m: any) => m.permission.userId === testUser1.id);
    expect(owner).toBeDefined();
    expect(owner.permission.permission).toBe("owner");
  });

  it("should add a space member", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "editor",
          userId: testUser2.id,
          action: "grant",
        }),
      },
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.permission.userId).toBe(testUser2.id);
    expect(data.permission.permission).toBe("editor");
  });

  it("should allow newly added member to see the space in their spaces list", async () => {
    // User2 was just added to the space as editor
    // Now check if they can see it in their spaces list
    const response = await apiRequest("/api/v1/spaces", session2Token);

    expect(response.status).toBe(200);
    const spaces = await response.json();
    expect(Array.isArray(spaces)).toBe(true);

    // User2 should see the space they were added to
    const memberSpace = spaces.find((s: any) => s.id === testSpaceId);
    expect(memberSpace).toBeDefined();
    expect(memberSpace.name).toBe("ACL Test Space");
  });

  it("should allow newly added member to access the space directly", async () => {
    // User2 should be able to access space details
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}`, session2Token);

    expect(response.status).toBe(200);
    const space = await response.json();
    expect(space.id).toBe(testSpaceId);
    expect(space.name).toBe("ACL Test Space");
  });

  it("should allow newly added member to list documents in the space", async () => {
    // User2 should be able to list documents in the space
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents`,
      session2Token,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data.documents)).toBe(true);
  });

  it("should not show space to user who is not a member", async () => {
    // User3 is not a member of the space yet
    const response = await apiRequest("/api/v1/spaces", session3Token);

    expect(response.status).toBe(200);
    const spaces = await response.json();
    expect(Array.isArray(spaces)).toBe(true);

    // User3 should not see the space
    const memberSpace = spaces.find((s: any) => s.id === testSpaceId);
    expect(memberSpace).toBeUndefined();
  });

  it("should show space to user after being added as member", async () => {
    // Add user3 as a member
    const addResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "viewer",
          userId: testUser3.id,
          action: "grant",
        }),
      },
    );

    expect(addResponse.status).toBe(200);

    // Now user3 should see the space
    const listResponse = await apiRequest("/api/v1/spaces", session3Token);

    expect(listResponse.status).toBe(200);
    const spaces = await listResponse.json();
    expect(Array.isArray(spaces)).toBe(true);

    const memberSpace = spaces.find((s: any) => s.id === testSpaceId);
    expect(memberSpace).toBeDefined();
    expect(memberSpace.name).toBe("ACL Test Space");
  });

  it("should allow user with view permission to see previously created documents", async () => {
    // Create a new standalone user for this test
    const newUserData = await createTestUser("Standalone Viewer");
    const newUserId = newUserData.userId;
    const newUserToken = newUserData.token;

    // Add the new user as a viewer to the space
    // The document was already created in beforeAll, before this user existed
    const addMemberResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "viewer",
          userId: newUserId,
          action: "grant",
        }),
      },
    );

    expect(addMemberResponse.status).toBe(200);

    // The new user should be able to list documents and see the previously created document
    const listResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents`,
      newUserToken,
    );

    expect(listResponse.status).toBe(200);
    const data = await listResponse.json();
    expect(Array.isArray(data.documents)).toBe(true);
    expect(data.documents.length).toBeGreaterThan(0);

    // Verify the new user can see the document that was created before they were added
    const previousDocument = data.documents.find((doc: any) => doc.id === testDocumentId);
    expect(previousDocument).toBeDefined();
    expect(previousDocument.properties?.title).toBe("ACL Test Document");

    // Verify the new user can access the document directly
    const docResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}`,
      newUserToken,
    );

    expect(docResponse.status).toBe(200);
    const docData = await docResponse.json();
    expect(docData.document.id).toBe(testDocumentId);
    expect(docData.document.properties?.title).toBe("ACL Test Document");
  });

  it("should get a specific space member", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions?type=role`,
      session1Token,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    const members = data.permissions;
    const member = members.find((m: any) => m.permission.userId === testUser2.id);
    expect(member).toBeDefined();
    expect(member.permission.userId).toBe(testUser2.id);
    expect(member.permission.permission).toBe("editor");
  });

  it("should update a space member role", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "editor",
          userId: testUser2.id,
          action: "grant",
        }),
      },
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.permission.permission).toBe("editor");
  });

  it("should not allow non-owner to add members", async () => {
    // Add user3 as viewer
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        userId: testUser3.id,
        action: "grant",
      }),
    });

    // Try to add another member as user3 (viewer)
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      session3Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "viewer",
          userId: "some-other-user",
          action: "grant",
        }),
      },
    );

    expect(response.status).toBe(403);
  });

  it("should remove a space member", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "viewer",
          userId: testUser3.id,
          action: "revoke",
        }),
      },
    );

    expect(response.status).toBe(200);

    // Verify member is gone
    const checkResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions?type=role`,
      session1Token,
    );

    expect(checkResponse.status).toBe(200);
    const data = await checkResponse.json();
    const members = data.permissions;
    const member = members.find((m: any) => m.permission.userId === testUser3.id);
    expect(member).toBeUndefined();
  });

  it("should not show space to removed member", async () => {
    // User3 was just removed from the space
    // They should no longer see it in their spaces list
    const response = await apiRequest("/api/v1/spaces", session3Token);

    expect(response.status).toBe(200);
    const spaces = await response.json();
    expect(Array.isArray(spaces)).toBe(true);

    const memberSpace = spaces.find((s: any) => s.id === testSpaceId);
    expect(memberSpace).toBeUndefined();
  });

  it("should deny removed member access to space details", async () => {
    // User3 should no longer be able to access the space
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}`, session3Token);

    expect(response.status).toBe(403);
  });

  it("should allow editor to create documents", async () => {
    // User2 is an editor in the space
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents`,
      session2Token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "# Editor Created Document\n\nCreated by editor.",
          properties: {
            title: "Editor Created Document",
          },
        }),
      },
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.document).toBeDefined();
    expect(data.document.slug).toBeDefined();
  });

  it("should not allow viewer to create documents", async () => {
    // User3 is a viewer in the space
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents`,
      session3Token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "# Viewer Attempt\n\nShould fail.",
          properties: {
            title: "Viewer Attempt",
          },
        }),
      },
    );

    expect(response.status).toBe(403);
  });
});

describe("ACL API Tests - Document Members", () => {
  // These tests were reimplemented to use the unified /permissions API.
  // Document-level membership is managed via POST /api/v1/spaces/:spaceId/permissions
  // with resourceType: "document" and resourceId equal to the document id.

  async function listDocumentMembers(spaceId: string, documentId: string, token: string) {
    const resp = await apiRequest(
      `/api/v1/spaces/${spaceId}/permissions?type=role&resourceType=document&resourceId=${documentId}`,
      token,
    );
    expect(resp.status === 200 || resp.status === 403).toBe(true);
    // If caller lacks permissions to list, return empty array for further checks
    if (resp.status !== 200) return [];
    const body = await resp.json();
    const perms = Array.isArray(body.permissions)
      ? body.permissions.map((p: any) => p.permission || p)
      : [];
    return perms;
  }

  it("should list document members", async () => {
    const members = await listDocumentMembers(testSpaceId, testDocumentId, session1Token);
    expect(Array.isArray(members)).toBe(true);

    // Owner should be present among document-level owners (or implied)
    const owner = members.find((m: any) => m.userId === testUser1.id);
    // The permissions API may not list explicit document owners if only space-level owner exists,
    // so accept either explicit membership or space ownership inferred via a check.
    if (owner) {
      expect(owner.permission || owner.role).toBeDefined();
    } else {
      // Fallback: ensure space owner exists by listing space-level members
      const spacePermsResp = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/permissions?type=role`,
        session1Token,
      );
      const spaceBody = await spacePermsResp.json();
      const spacePerms = Array.isArray(spaceBody.permissions)
        ? spaceBody.permissions.map((p: any) => p.permission || p)
        : [];
      const spaceOwner = spacePerms.find(
        (p: any) =>
          p.userId === testUser1.id && (p.permission === "owner" || p.role === "owner"),
      );
      expect(spaceOwner).toBeDefined();
    }
  });

  it("should add a document member", async () => {
    const resp = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "editor",
          userId: testUser2.id,
          resourceType: "document",
          resourceId: testDocumentId,
          action: "grant",
        }),
      },
    );

    expect(resp.status === 200 || resp.status === 201).toBe(true);
    const data = await resp.json();
    const entry = data.permission || data;
    expect(entry.userId).toBe(testUser2.id);
    expect(entry.permission || entry.role).toBe("editor");

    // verify via listing
    const members = await listDocumentMembers(testSpaceId, testDocumentId, session1Token);
    const found = members.find((m: any) => m.userId === testUser2.id);
    expect(found).toBeDefined();
  });

  it("should get a specific document member", async () => {
    // We emulate getting a specific document member by listing and filtering.
    const members = await listDocumentMembers(testSpaceId, testDocumentId, session1Token);
    const member = members.find((m: any) => m.userId === testUser2.id);
    expect(member).toBeDefined();
    expect(member.userId).toBe(testUser2.id);
    expect(member.permission || member.role).toBeDefined();
  });

  it("should update a document member role", async () => {
    const resp = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "viewer",
          userId: testUser2.id,
          resourceType: "document",
          resourceId: testDocumentId,
          action: "grant",
        }),
      },
    );

    expect(resp.status === 200 || resp.status === 201).toBe(true);
    const data = await resp.json();
    const entry = data.permission || data;
    // role name might be present under `permission` property
    expect(entry.permission || entry.role).toBe("viewer");

    // verify via listing
    const members = await listDocumentMembers(testSpaceId, testDocumentId, session1Token);
    const found = members.find((m: any) => m.userId === testUser2.id);
    expect(found).toBeDefined();
    expect(found.permission || found.role).toBe("viewer");
  });

  it("should not allow viewer to add document members", async () => {
    // Ensure user2 is a viewer at document level
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        userId: testUser2.id,
        resourceType: "document",
        resourceId: testDocumentId,
        action: "grant",
      }),
    });

    const resp = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      session2Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "editor",
          userId: testUser3.id,
          resourceType: "document",
          resourceId: testDocumentId,
          action: "grant",
        }),
      },
    );

    expect(resp.status).toBe(403);
  });

  it("should remove a document member", async () => {
    const resp = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "viewer",
          userId: testUser2.id,
          resourceType: "document",
          resourceId: testDocumentId,
          action: "revoke",
        }),
      },
    );

    expect(resp.status === 200).toBe(true);

    const members = await listDocumentMembers(testSpaceId, testDocumentId, session1Token);
    const found = members.find((m: any) => m.userId === testUser2.id);
    expect(found).toBeUndefined();
  });
});

describe("ACL API Tests - Permission Inheritance", () => {
  beforeAll(async () => {
    // Grant user2 editor access to space
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "editor",
        userId: testUser2.id,
        action: "grant",
      }),
    });
  });

  it("should allow space editor to access documents", async () => {
    // User2 has editor access to space, should be able to view document
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}`,
      session2Token,
    );

    expect(response.status).toBe(200);
  });

  it("should allow space editor to edit documents", async () => {
    // User2 has editor access to space, should be able to update document
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}`,
      session2Token,
      {
        method: "PUT",
        body: JSON.stringify({
          content: "# Updated by User2\n\nContent updated.",
        }),
      },
    );

    expect(response.status).toBe(200);
  });

  it("should not allow space viewer to edit documents", async () => {
    // Add user3 as viewer to space
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        userId: testUser3.id,
        action: "grant",
      }),
    });

    // User3 has viewer access, should not be able to update document
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}`,
      session3Token,
      {
        method: "PUT",
        body: JSON.stringify({
          content: "# Should not work",
        }),
      },
    );

    expect(response.status).toBe(403);
  });

  it("should allow space viewer to view documents", async () => {
    // User3 has viewer access to space
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}`,
      session3Token,
    );

    expect(response.status).toBe(200);
  });
});

describe("ACL API Tests - Access Control", () => {
  it("should deny access to non-member", async () => {
    // Create a new user not in the space
    const nonMemberData = await createTestUser("Non Member");
    const nonMemberToken = nonMemberData.token;

    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents`,
      nonMemberToken,
    );

    expect(response.status).toBe(403);
  });

  it("should deny document access without permission", async () => {
    // Create another document as owner
    const doc2Response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "# Private Document",
          properties: {
            title: "Private Document",
          },
        }),
      },
    );

    expect(doc2Response.status === 200 || doc2Response.status === 201).toBe(true);
    const doc2Data = await doc2Response.json();
    const doc2Id = doc2Data.document.id;

    // Revoke any space-level access for user2 (owner must perform)
    // Remove user2 from space so they have no access
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "editor",
        userId: testUser2.id,
        action: "revoke",
      }),
    });

    // Also revoke viewer just in case
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        userId: testUser2.id,
        action: "revoke",
      }),
    });

    // Ensure no document-level permission exists for user2
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: null,
        userId: testUser2.id,
        resourceType: "document",
        resourceId: doc2Id,
        action: "revoke",
      }),
    });

    // User2 should not be able to access the new document
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${doc2Id}`,
      session2Token,
    );

    expect(response.status).toBe(403);
  });

  it("should allow document-specific access", async () => {
    // Create a document
    const docResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "# Shared Document",
          properties: {
            title: "Shared Document",
          },
        }),
      },
    );

    const docData = await docResponse.json();
    const docId = docData.document.id;

    // Grant user2 direct access to this specific document
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "editor",
        userId: testUser2.id,
        resourceType: "document",
        resourceId: docId,
        action: "grant",
      }),
    });

    // User2 should be able to access this document even without space membership
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${docId}`,
      session2Token,
    );

    expect(response.status).toBe(200);
  });
});

describe("ACL API Tests - Search Access Control", () => {
  beforeAll(async () => {
    // Ensure user2 has space access for search
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "editor",
        userId: testUser2.id,
        action: "grant",
      }),
    });
  });

  it("should only return accessible documents in search", async () => {
    // User2 should be able to search (has space access)
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?q=test`,
      session2Token,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toBeDefined();
    expect(Array.isArray(data.results)).toBe(true);
  });

  it("should deny search to non-members", async () => {
    // Create a user not in the space
    const nonMemberData = await createTestUser("Search Non Member");
    const nonMemberToken = nonMemberData.token;

    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?q=test`,
      nonMemberToken,
    );

    expect(response.status).toBe(403);
  });
});

describe("ACL API Tests - Categories Access Control", () => {
  let testCategoryId: string;

  beforeAll(async () => {
    // Ensure user2 is editor and user3 is viewer
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "editor",
        userId: testUser2.id,
        action: "grant",
      }),
    });

    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        userId: testUser3.id,
        action: "grant",
      }),
    });
  });

  it("should allow member to list categories", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/categories`,
      session3Token, // viewer
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.categories).toBeDefined();
    expect(Array.isArray(data.categories)).toBe(true);
  });

  it("should allow editor to create category", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/categories`,
      session2Token, // editor
      {
        method: "POST",
        body: JSON.stringify({
          name: "Test Category",
          slug: "test-category",
          description: "A test category",
          color: "#ff0000",
          icon: "folder",
        }),
      },
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.category).toBeDefined();
    expect(data.category.name).toBe("Test Category");
    testCategoryId = data.category.id;
  });

  it("should not allow viewer to create category", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/categories`,
      session3Token, // viewer
      {
        method: "POST",
        body: JSON.stringify({
          name: "Viewer Category",
          slug: "viewer-category",
        }),
      },
    );

    expect(response.status).toBe(403);
  });

  it("should allow member to view specific category", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/categories/${testCategoryId}`,
      session3Token, // viewer
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.category).toBeDefined();
    expect(data.category.id).toBe(testCategoryId);
  });

  it("should allow editor to update category", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/categories/${testCategoryId}`,
      session2Token, // editor
      {
        method: "PUT",
        body: JSON.stringify({
          name: "Updated Category",
          slug: "test-category",
          description: "Updated description",
        }),
      },
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.category.name).toBe("Updated Category");
  });

  it("should not allow viewer to update category", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/categories/${testCategoryId}`,
      session3Token, // viewer
      {
        method: "PUT",
        body: JSON.stringify({
          name: "Viewer Update",
          slug: "test-category",
        }),
      },
    );

    expect(response.status).toBe(403);
  });

  it("should allow editor to delete category", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/categories/${testCategoryId}`,
      session2Token, // editor
      {
        method: "DELETE",
      },
    );

    expect(response.status).toBe(200);
  });

  it("should not allow viewer to delete category", async () => {
    // Create another category to delete
    const createResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/categories`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          name: "Delete Test",
          slug: "delete-test",
        }),
      },
    );
    const categoryId = (await createResponse.json()).category.id;

    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/categories/${categoryId}`,
      session3Token, // viewer
      {
        method: "DELETE",
      },
    );

    expect(response.status).toBe(403);
  });
});

describe("ACL API Tests - Properties Access Control", () => {
  let testDocForProps: string;

  beforeAll(async () => {
    // Create a document for property tests
    const docResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "# Properties Test Doc",
          properties: {
            title: "Properties Test",
          },
        }),
      },
    );
    testDocForProps = (await docResponse.json()).document.id;
  });

  it("should allow member to list space properties", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/properties`,
      session3Token, // viewer
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.properties).toBeDefined();
    expect(Array.isArray(data.properties)).toBe(true);
  });

  it("should allow editor to update document property", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocForProps}`,
      session2Token, // editor
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
  });

  it("should not allow viewer to update document property", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocForProps}`,
      session3Token, // viewer
      {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            status: { value: "draft" },
          },
        }),
      },
    );

    expect(response.status).toBe(403);
  });

  it("should allow editor to delete document property", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocForProps}`,
      session2Token, // editor
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
  });

  it("should not allow viewer to delete document property", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocForProps}`,
      session3Token, // viewer
      {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            title: null,
          },
        }),
      },
    );

    expect(response.status).toBe(403);
  });
});

describe("ACL API Tests - Document Children Access Control", () => {
  let parentDocId: string;

  beforeAll(async () => {
    // Create a parent document
    const parentResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "# Parent Document",
          properties: {
            title: "Parent Document",
          },
        }),
      },
    );
    parentDocId = (await parentResponse.json()).document.id;

    // Create a child document
    const childResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "# Child Document",
          properties: {
            title: "Child Document",
          },
          parentId: parentDocId,
        }),
      },
    );
    await childResponse.json();
  });

  it("should allow member to view document children", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${parentDocId}/children`,
      session3Token, // viewer
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.children).toBeDefined();
    expect(Array.isArray(data.children)).toBe(true);
    expect(data.children.length).toBeGreaterThan(0);
  });

  it("should allow editor to view document children", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${parentDocId}/children`,
      session2Token, // editor
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.children).toBeDefined();
  });

  it("should deny non-member access to document children", async () => {
    const nonMemberData = await createTestUser("Children Non Member");
    const nonMemberToken = nonMemberData.token;

    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${parentDocId}/children`,
      nonMemberToken,
    );

    expect(response.status).toBe(403);
  });
});

describe("ACL API Tests - Permission Level Access", () => {
  let testSpaceForLevels: string;
  let viewerUser: { id: string; email: string; name: string };
  let viewerToken: string;
  let editorUser: { id: string; email: string; name: string };
  let editorToken: string;
  let adminUser: { id: string; email: string; name: string };
  let adminToken: string;

  beforeAll(async () => {
    // Create test space
    const spaceResponse = await apiRequest("/api/v1/spaces", session1Token, {
      method: "POST",
      body: JSON.stringify({
        name: "Permission Levels Test Space",
        slug: `perm-levels-${Date.now()}`,
      }),
    });
    const spaceData = await spaceResponse.json();
    testSpaceForLevels = spaceData.space.id;

    // Create viewer user
    const viewerData = await createTestUser("Viewer User");
    viewerUser = {
      id: viewerData.userId,
      email: viewerData.email,
      name: viewerData.name,
    };
    viewerToken = viewerData.token;

    // Create editor user
    const editorData = await createTestUser("Editor User");
    editorUser = {
      id: editorData.userId,
      email: editorData.email,
      name: editorData.name,
    };
    editorToken = editorData.token;

    // Create editor user with owner-level access for testing
    const adminData = await createTestUser("Editor User");
    adminUser = {
      id: adminData.userId,
      email: adminData.email,
      name: adminData.name,
    };
    adminToken = adminData.token;

    // Grant viewer permission
    await apiRequest(`/api/v1/spaces/${testSpaceForLevels}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        userId: viewerUser.id,
        action: "grant",
      }),
    });

    // Grant editor permission
    await apiRequest(`/api/v1/spaces/${testSpaceForLevels}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "editor",
        userId: editorUser.id,
        action: "grant",
      }),
    });

    // Grant editor permission
    await apiRequest(`/api/v1/spaces/${testSpaceForLevels}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "editor",
        userId: adminUser.id,
        action: "grant",
      }),
    });
  });

  it("should allow viewer to access space", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceForLevels}`,
      viewerToken,
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe(testSpaceForLevels);
  });

  it("should allow viewer to list documents", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceForLevels}/documents`,
      viewerToken,
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.documents).toBeDefined();
    expect(Array.isArray(data.documents)).toBe(true);
  });

  it("should allow viewer to list categories", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceForLevels}/categories`,
      viewerToken,
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.categories).toBeDefined();
  });

  it("should allow viewer to see space in their spaces list", async () => {
    const response = await apiRequest("/api/v1/spaces", viewerToken);
    expect(response.status).toBe(200);
    const data = await response.json();
    const hasSpace = data.some((s: any) => s.id === testSpaceForLevels);
    expect(hasSpace).toBe(true);
  });

  it("should allow editor to access space", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceForLevels}`,
      editorToken,
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe(testSpaceForLevels);
  });

  it("should allow editor to list documents", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceForLevels}/documents`,
      editorToken,
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.documents).toBeDefined();
  });

  it("should allow editor to create documents", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceForLevels}/documents`,
      editorToken,
      {
        method: "POST",
        body: JSON.stringify({
          content: "# Editor Test Doc",
          properties: { title: "Editor Test" },
        }),
      },
    );
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.document.id).toBeDefined();
  });

  it("should allow editor to see space in their spaces list", async () => {
    const response = await apiRequest("/api/v1/spaces", editorToken);
    expect(response.status).toBe(200);
    const data = await response.json();
    const hasSpace = data.some((s: any) => s.id === testSpaceForLevels);
    expect(hasSpace).toBe(true);
  });

  it("should allow editor to access space", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceForLevels}`, adminToken);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe(testSpaceForLevels);
  });

  it("should allow editor to list documents", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceForLevels}/documents`,
      adminToken,
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.documents).toBeDefined();
  });

  it("should allow editor to create documents", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceForLevels}/documents`,
      adminToken,
      {
        method: "POST",
        body: JSON.stringify({
          content: "# Admin Test Doc",
          properties: { title: "Admin Test" },
        }),
      },
    );
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.document.id).toBeDefined();
  });

  it("should not allow editor to add new members", async () => {
    const newUserData = await createTestUser("New Member User");
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceForLevels}/permissions`,
      adminToken,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "viewer",
          userId: newUserData.userId,
          action: "grant",
        }),
      },
    );
    expect(response.status).toBe(403);
  });

  it("should allow editor to see space in their spaces list", async () => {
    const response = await apiRequest("/api/v1/spaces", adminToken);
    expect(response.status).toBe(200);
    const data = await response.json();
    const hasSpace = data.some((s: any) => s.id === testSpaceForLevels);
    expect(hasSpace).toBe(true);
  });

  it("should not allow viewer to create documents", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceForLevels}/documents`,
      viewerToken,
      {
        method: "POST",
        body: JSON.stringify({
          content: "# Viewer Test Doc",
          properties: { title: "Viewer Test" },
        }),
      },
    );
    expect(response.status).toBe(403);
  });

  it("should not allow viewer to add members", async () => {
    const newUserData = await createTestUser("Viewer Attempt User");
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceForLevels}/permissions`,
      viewerToken,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "viewer",
          userId: newUserData.userId,
          action: "grant",
        }),
      },
    );
    expect(response.status).toBe(403);
  });

  it("should not allow editor to add members", async () => {
    const newUserData = await createTestUser("Editor Attempt User");
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceForLevels}/permissions`,
      editorToken,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "viewer",
          userId: newUserData.userId,
          action: "grant",
        }),
      },
    );
    expect(response.status).toBe(403);
  });
});

describe("ACL API Tests - Markdown content negotiation", () => {
  let mdTestSpaceId: string;
  let mdTestSpaceSlug: string;
  let mdOwnerToken: string;
  let mdViewerUser: { id: string; email: string; name: string };
  let mdViewerToken: string;
  let mdNonMemberUser: { id: string; email: string; name: string };
  let mdNonMemberToken: string;
  let testDocSlug: string;

  beforeAll(async () => {
    // Create isolated users for markdown tests
    const ownerData = await createTestUser("MD Owner");
    mdOwnerToken = ownerData.token;

    const viewerData = await createTestUser("MD Viewer");
    mdViewerUser = {
      id: viewerData.userId,
      email: viewerData.email,
      name: viewerData.name,
    };
    mdViewerToken = viewerData.token;

    const nonMemberData = await createTestUser("MD Non-Member");
    mdNonMemberUser = {
      id: nonMemberData.userId,
      email: nonMemberData.email,
      name: nonMemberData.name,
    };
    mdNonMemberToken = nonMemberData.token;

    // Create isolated space for markdown tests
    const spaceResponse = await apiRequest("/api/v1/spaces", mdOwnerToken, {
      method: "POST",
      body: JSON.stringify({
        name: "MD Test Space",
        slug: `md-test-space-${Date.now()}`,
      }),
    });
    const spaceData = await spaceResponse.json();
    mdTestSpaceId = spaceData.space.id;
    mdTestSpaceSlug = spaceData.space.slug;

    // Create a test document
    const docResponse = await apiRequest(
      `/api/v1/spaces/${mdTestSpaceId}/documents`,
      mdOwnerToken,
      {
        method: "POST",
        body: JSON.stringify({
          content:
            "# Test Markdown Export\n\nThis document tests .md endpoint access control.",
          properties: {
            title: "Test Markdown Export",
          },
        }),
      },
    );

    const docData = await docResponse.json();
    testDocSlug = docData.document.slug;
  });

  it("should allow space owner to access document as markdown", async () => {
    const response = await fetch(`${BASE_URL}/${mdTestSpaceSlug}/doc/${testDocSlug}`, {
      headers: {
        Accept: "text/markdown",
        Cookie: `vektor.session_token=${mdOwnerToken}`,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/markdown");
    const content = await response.text();
    expect(content).toContain("Test Markdown Export");
    expect(content).toContain(`slug: ${testDocSlug}`);
  });

  it("should not expose the former .md route", async () => {
    const response = await fetch(`${BASE_URL}/${mdTestSpaceSlug}/doc/${testDocSlug}.md`, {
      headers: {
        Accept: "text/markdown",
        Cookie: `vektor.session_token=${mdOwnerToken}`,
      },
    });

    expect(response.status).toBe(404);
  });

  it("should allow space member with viewer role to access document as markdown", async () => {
    // Add viewer to space
    await apiRequest(`/api/v1/spaces/${mdTestSpaceId}/permissions`, mdOwnerToken, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        userId: mdViewerUser.id,
        action: "grant",
      }),
    });

    const response = await fetch(`${BASE_URL}/${mdTestSpaceSlug}/doc/${testDocSlug}`, {
      headers: {
        Accept: "text/markdown",
        Cookie: `vektor.session_token=${mdViewerToken}`,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/markdown");
  });

  it("should deny non-member access to document as markdown", async () => {
    const response = await fetch(`${BASE_URL}/${mdTestSpaceSlug}/doc/${testDocSlug}`, {
      headers: {
        Accept: "text/markdown",
        Cookie: `vektor.session_token=${mdNonMemberToken}`,
      },
    });

    expect(response.status).toBe(403);
  });

  it("should deny access after member is removed from space", async () => {
    // Remove viewer from space
    await apiRequest(`/api/v1/spaces/${mdTestSpaceId}/permissions`, mdOwnerToken, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        userId: mdViewerUser.id,
        action: "revoke",
      }),
    });

    const response = await fetch(`${BASE_URL}/${mdTestSpaceSlug}/doc/${testDocSlug}`, {
      headers: {
        Accept: "text/markdown",
        Cookie: `vektor.session_token=${mdViewerToken}`,
      },
    });

    expect(response.status).toBe(403);
  });

  it("should allow document-specific member access to markdown export", async () => {
    // Create a new document
    const docResponse = await apiRequest(
      `/api/v1/spaces/${mdTestSpaceId}/documents`,
      mdOwnerToken,
      {
        method: "POST",
        body: JSON.stringify({
          content: "# Document-specific Access Test",
          properties: {
            title: "Document-specific Access Test",
          },
        }),
      },
    );

    const docData = await docResponse.json();
    const docSlug = docData.document.slug;
    const docId = docData.document.id;

    // Grant non-member direct access to this specific document
    await apiRequest(`/api/v1/spaces/${mdTestSpaceId}/permissions`, mdOwnerToken, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        userId: mdNonMemberUser.id,
        resourceType: "document",
        resourceId: docId,
        action: "grant",
      }),
    });

    // Non-member should be able to access markdown export with document-level permission
    const response = await fetch(`${BASE_URL}/${mdTestSpaceSlug}/doc/${docSlug}`, {
      headers: {
        Accept: "text/markdown",
        Cookie: `vektor.session_token=${mdNonMemberToken}`,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/markdown");
  });

  it("should apply the route's normal unauthenticated redirect", async () => {
    const response = await fetch(`${BASE_URL}/${mdTestSpaceSlug}/doc/${testDocSlug}`, {
      headers: { Accept: "text/markdown" },
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
  });

  it("should return 404 for non-existent document slug", async () => {
    const response = await fetch(
      `${BASE_URL}/${mdTestSpaceSlug}/doc/non-existent-slug-12345`,
      {
        headers: {
          Accept: "text/markdown",
          Cookie: `vektor.session_token=${mdOwnerToken}`,
        },
      },
    );

    expect(response.status).toBe(404);
  });

  it("should return 404 for non-existent space slug", async () => {
    const response = await fetch(`${BASE_URL}/non-existent-space/doc/${testDocSlug}`, {
      headers: {
        Accept: "text/markdown",
        Cookie: `vektor.session_token=${mdOwnerToken}`,
      },
    });

    expect(response.status).toBe(404);
  });
});

describe("ACL API Tests - Public Access with Owner Override", () => {
  let publicTestSpaceId: string;
  let publicTestSpaceSlug: string;
  let ownerUser: { id: string; token: string };
  let publicTestDocId: string;
  let publicTestDocSlug: string;

  beforeAll(async () => {
    // Create test space with owner
    const ownerData = await createTestUser("Public Test Owner");
    ownerUser = {
      id: ownerData.userId,
      token: ownerData.token,
    };

    const spaceSlug = `public-test-${Date.now()}`;
    const spaceResponse = await apiRequest("/api/v1/spaces", ownerUser.token, {
      method: "POST",
      body: JSON.stringify({
        name: "Public Access Test Space",
        slug: spaceSlug,
      }),
    });
    const spaceData = await spaceResponse.json();
    publicTestSpaceId = spaceData.space.id;
    publicTestSpaceSlug = spaceSlug;

    // Create a test document
    const docResponse = await apiRequest(
      `/api/v1/spaces/${publicTestSpaceId}/documents`,
      ownerUser.token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "<p>Public test document</p>",
          properties: {
            title: "Public Test Document",
            slug: "public-test-doc",
          },
        }),
      },
    );
    const docData = await docResponse.json();
    publicTestDocId = docData.document.id;
    publicTestDocSlug = docData.document.slug;

    // Make the space publicly accessible (viewer permission)
    await apiRequest(`/api/v1/spaces/${publicTestSpaceId}/permissions`, ownerUser.token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        groupId: "public",
        action: "grant",
      }),
    });
  });

  it("should allow owner to access space settings despite public viewer access", async () => {
    // Owner should still have owner permissions, not be limited to public viewer
    const response = await apiRequest(
      `/api/v1/spaces/${publicTestSpaceId}`,
      ownerUser.token,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toBeDefined();
    expect(data.id).toBe(publicTestSpaceId);
  });

  it("should allow owner to list members despite public access", async () => {
    // Owner should be able to list members (requires owner permission)
    const response = await apiRequest(
      `/api/v1/spaces/${publicTestSpaceId}/permissions?type=role`,
      ownerUser.token,
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.permissions.length).toBeGreaterThan(0);
    expect(Array.isArray(data.permissions)).toBe(true);
  });

  it("should allow owner to add members despite public access", async () => {
    // Create a new user to add
    const newUser = await createTestUser("New Member");

    // Owner should be able to add members (requires owner permission)
    const response = await apiRequest(
      `/api/v1/spaces/${publicTestSpaceId}/permissions`,
      ownerUser.token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "editor",
          userId: newUser.userId,
          action: "grant",
        }),
      },
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toBeDefined();
    expect(data.permission.userId).toBe(newUser.userId);
    expect(data.permission.permission).toBe("editor");
  });

  it("should allow owner to create documents despite public viewer access", async () => {
    // Owner should be able to create documents (requires editor/owner permission)
    const response = await apiRequest(
      `/api/v1/spaces/${publicTestSpaceId}/documents`,
      ownerUser.token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "<p>Owner created document</p>",
          properties: {
            title: "Owner Document",
          },
        }),
      },
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.document).toBeDefined();
    expect(data.document.properties.title).toBe("Owner Document");
  });

  it("should allow owner to edit documents despite public viewer access", async () => {
    // Owner should be able to edit documents (requires editor/owner permission)
    const response = await apiRequest(
      `/api/v1/spaces/${publicTestSpaceId}/documents/${publicTestDocId}`,
      ownerUser.token,
      {
        method: "PUT",
        body: JSON.stringify({
          content: "<p>Updated by owner</p>",
        }),
      },
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.document).toBeDefined();
  });

  it("should allow owner to delete documents despite public viewer access", async () => {
    // Create a document to delete
    const createResponse = await apiRequest(
      `/api/v1/spaces/${publicTestSpaceId}/documents`,
      ownerUser.token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "<p>Document to delete</p>",
          properties: {
            title: "Delete Me",
          },
        }),
      },
    );
    const createData = await createResponse.json();
    const docToDelete = createData.document.id;

    // Owner should be able to delete documents (requires owner permission)
    const response = await apiRequest(
      `/api/v1/spaces/${publicTestSpaceId}/documents/${docToDelete}`,
      ownerUser.token,
      {
        method: "DELETE",
      },
    );

    expect(response.status).toBe(200);
  });

  it("should allow unauthenticated users to access public documents via frontend route", async () => {
    // Unauthenticated users should be able to access documents in spaces with public access
    const response = await fetch(
      `${BASE_URL}/${publicTestSpaceSlug}/doc/${publicTestDocSlug}`,
      {
        redirect: "manual",
      },
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Public Test Document");
  });
});

describe("ACL API Tests - Unauthenticated Access", () => {
  it("should return 401 for unauthenticated access to audit logs", async () => {
    const response = await fetch(
      `${BASE_URL}/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/audit-logs`,
      { headers: { "Content-Type": "application/json" } },
    );
    expect(response.status).toBe(401);
  });

  it("should return 401 for unauthenticated access to contributors", async () => {
    const response = await fetch(
      `${BASE_URL}/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/contributors`,
      { headers: { "Content-Type": "application/json" } },
    );
    expect(response.status).toBe(401);
  });
});

describe("ACL API Tests - Users", () => {
  it("should return 401 for unauthenticated request to list users", async () => {
    const response = await fetch(`${BASE_URL}/api/v1/users`, {
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(401);
  });

  it("should list users when authenticated", async () => {
    const response = await apiRequest(
      `/api/v1/users?spaceId=${testSpaceId}`,
      session1Token,
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    const user = data[0];
    expect(user).toHaveProperty("id");
    expect(user).toHaveProperty("name");
  });
});

describe("Permissions API - Get Current User Permissions", () => {
  it("should return all features and owner role for owner", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions/me`,
      session1Token,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();

    expect(data.role).toBe("owner");
    expect(data.features).toBeDefined();
    expect(data.features.comment).toBe(true);
    expect(data.features.view_history).toBe(true);
    expect(data.features.view_audit).toBe(true);
    expect(data.features.manage_extensions).toBe(true);
  });

  it("should return default editor features for editor", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions/me`,
      session2Token,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();

    expect(data.role).toBe("editor");
    expect(data.features).toBeDefined();
    expect(data.features.comment).toBe(true);
    expect(data.features.view_history).toBe(true);
    expect(data.features.view_audit).toBe(false);
    expect(data.features.manage_extensions).toBe(false);
  });

  it("should return viewer role and no features by default", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions/me`,
      session3Token,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();

    expect(data.role).toBe("viewer");
    expect(data.features).toBeDefined();
    expect(data.features.comment).toBe(false);
    expect(data.features.view_history).toBe(false);
    expect(data.features.view_audit).toBe(false);
    expect(data.features.manage_extensions).toBe(false);
  });
});

describe("Permissions API - Comments Feature", () => {
  it("should allow owner to create comments", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${featuresTestDocumentId}/comments`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "Owner comment test",
          reference: "120",
        }),
      },
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.comment).toBeDefined();
    expect(data.comment.content).toBe("Owner comment test");
  });

  it("should allow editor to create comments", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${featuresTestDocumentId}/comments`,
      session2Token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "Editor comment test",
          reference: "240",
        }),
      },
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.comment).toBeDefined();
    expect(data.comment.content).toBe("Editor comment test");
  });

  it("should deny viewer from creating comments by default", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${featuresTestDocumentId}/comments`,
      session3Token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "Viewer comment test - should fail",
          reference: "360",
        }),
      },
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });

  it("should allow viewer to read comments", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${featuresTestDocumentId}/comments`,
      session3Token,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.comments).toBeDefined();
    expect(Array.isArray(data.comments)).toBe(true);
  });

  it("should require reference for top-level comments", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${featuresTestDocumentId}/comments`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "Missing reference",
        }),
      },
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("Reference is required");
  });
});

describe("Permissions API - Document History Feature", () => {
  it("should allow owner to view document history", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${featuresTestDocumentId}/revisions`,
      session1Token,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.revisions).toBeDefined();
  });

  it("should allow editor to view document history", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${featuresTestDocumentId}/revisions`,
      session2Token,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.revisions).toBeDefined();
  });

  it("should deny viewer from viewing document history by default", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${featuresTestDocumentId}/revisions`,
      session3Token,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });
});

describe("Permissions API - Audit Logs Feature", () => {
  it("should allow owner to view space audit logs", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/audit-logs`,
      session1Token,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.auditLogs).toBeDefined();
  });

  it("should allow owner to view document audit logs", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${featuresTestDocumentId}/audit-logs`,
      session1Token,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.auditLogs).toBeDefined();
  });

  it("should deny editor from viewing space audit logs by default", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/audit-logs`,
      session2Token,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });

  it("should deny editor from viewing document audit logs by default", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${featuresTestDocumentId}/audit-logs`,
      session2Token,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });

  it("should deny viewer from viewing space audit logs", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/audit-logs`,
      session3Token,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });

  it("should deny viewer from viewing document audit logs", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${featuresTestDocumentId}/audit-logs`,
      session3Token,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });
});

describe("Permissions API - Unified Permissions Management", () => {
  it("should allow owner to list all permissions", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions`,
      session1Token,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.permissions).toBeDefined();
    expect(Array.isArray(data.permissions)).toBe(true);
  });

  it("should allow owner to list only role permissions", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions?type=role`,
      session1Token,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.permissions).toBeDefined();
    const rolePerms = data.permissions.filter((p: any) => p.type === "role");
    expect(rolePerms.length).toBeGreaterThan(0);
  });

  it("should allow owner to list only feature permissions", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions?type=feature`,
      session1Token,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.permissions).toBeDefined();
  });

  it("should deny editor from listing permissions", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions`,
      session2Token,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });

  it("should deny viewer from listing permissions", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions`,
      session3Token,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });
});

describe("Permissions API - Grant/Deny/Revoke Features", () => {
  it("should allow owner to grant feature to user", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "feature",
          roleOrFeature: "comment",
          userId: testUser3.id,
          action: "grant",
        }),
      },
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.permission).toBeDefined();
    expect(data.permission.userId).toBe(testUser3.id);
    expect(data.permission.resourceId).toBe("comment");
  });

  it("should allow viewer to comment after feature grant", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${featuresTestDocumentId}/comments`,
      session3Token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "Viewer comment after grant",
          reference: "480",
        }),
      },
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.comment.content).toBe("Viewer comment after grant");
  });

  it("should reflect granted feature in user permissions", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions/me`,
      session3Token,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.features.comment).toBe(true);
  });

  it("should allow owner to deny feature from user", async () => {
    await apiRequest(`/api/v1/spaces/${featuresTestSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "feature",
        roleOrFeature: "view_history",
        userId: testUser2.id,
        action: "deny",
      }),
    });

    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${featuresTestDocumentId}/revisions`,
      session2Token,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });

  it("should allow owner to revoke feature (revert to default)", async () => {
    const revokeResponse = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "feature",
          roleOrFeature: "view_history",
          userId: testUser2.id,
          action: "revoke",
        }),
      },
    );

    expect(revokeResponse.ok).toBe(true);

    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${featuresTestDocumentId}/revisions`,
      session2Token,
    );

    expect(response.ok).toBe(true);
  });

  it("should reject invalid feature name", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "feature",
          roleOrFeature: "invalid_feature",
          userId: testUser3.id,
          action: "grant",
        }),
      },
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
  });

  it("should reject invalid action", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "feature",
          roleOrFeature: "comment",
          userId: testUser3.id,
          action: "invalid_action",
        }),
      },
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
  });

  it("should reject request without userId or groupId", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "feature",
          roleOrFeature: "comment",
          action: "grant",
        }),
      },
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
  });
});

describe("Permissions API - Grant/Deny/Revoke Roles", () => {
  it("should allow owner to grant role to user via permissions endpoint", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "editor",
          userId: testUser3.id,
          action: "grant",
        }),
      },
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.permission).toBeDefined();
  });

  it("should allow owner to revoke role via permissions endpoint", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "editor",
          userId: testUser3.id,
          action: "revoke",
        }),
      },
    );

    expect(response.ok).toBe(true);
  });
});

describe("Permissions API - Group-based Permissions", () => {
  it("should allow owner to grant feature to group", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "feature",
          roleOrFeature: "view_audit",
          groupId: "public",
          action: "grant",
        }),
      },
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.permission).toBeDefined();
    expect(data.permission.groupId).toBe("public");
  });

  it("should allow owner to revoke group feature", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/permissions`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "feature",
          roleOrFeature: "view_audit",
          groupId: "public",
          action: "revoke",
        }),
      },
    );

    expect(response.ok).toBe(true);
  });
});

describe("Permissions API - Edge Cases", () => {
  it("should handle user with both user-specific and group-based feature grants", async () => {
    await apiRequest(`/api/v1/spaces/${featuresTestSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "feature",
        roleOrFeature: "view_history",
        groupId: "public",
        action: "grant",
      }),
    });

    await apiRequest(`/api/v1/spaces/${featuresTestSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "feature",
        roleOrFeature: "view_history",
        userId: testUser3.id,
        action: "deny",
      }),
    });

    const response = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${featuresTestDocumentId}/revisions`,
      session3Token,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);

    await apiRequest(`/api/v1/spaces/${featuresTestSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "feature",
        roleOrFeature: "view_history",
        userId: testUser3.id,
        action: "revoke",
      }),
    });
    await apiRequest(`/api/v1/spaces/${featuresTestSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "feature",
        roleOrFeature: "view_history",
        groupId: "public",
        action: "revoke",
      }),
    });
  });
});

describe("ACL API Tests - Contributors", () => {
  let contributorsDocId: string;

  beforeAll(async () => {
    const resp = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "<p>contributors test</p>",
          properties: { title: "Contributors Test Doc" },
        }),
      },
    );
    if (!resp.ok)
      throw new Error(`Failed to create contributors doc: ${resp.statusText}`);
    contributorsDocId = (await resp.json()).document.id;
  });

  it("should return 401 for unauthenticated request", async () => {
    const resp = await fetch(
      `${BASE_URL}/api/v1/spaces/${featuresTestSpaceId}/documents/${contributorsDocId}/contributors`,
    );
    expect(resp.status).toBe(401);
  });

  it("should return contributors array for authenticated user", async () => {
    const resp = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${contributorsDocId}/contributors`,
      session1Token,
    );
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(Array.isArray(data.contributors)).toBe(true);
  });

  it("should include the document creator", async () => {
    const resp = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${contributorsDocId}/contributors`,
      session1Token,
    );
    const { contributors } = await resp.json();
    const creator = contributors.find((c: any) => c.id === testUser1.id);
    expect(creator).toBeDefined();
    expect(creator.email).toBe(testUser1.email);
    expect(creator.name).toBe(testUser1.name);
  });

  it("should include required fields for each contributor", async () => {
    const resp = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${contributorsDocId}/contributors`,
      session1Token,
    );
    const { contributors } = await resp.json();
    expect(contributors.length).toBeGreaterThan(0);
    for (const c of contributors) {
      expect(typeof c.id).toBe("string");
      expect(typeof c.name).toBe("string");
      expect(typeof c.email).toBe("string");
      expect("image" in c).toBe(true);
    }
  });

  it("should include contributors who saved revisions", async () => {
    await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${contributorsDocId}`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({ html: "<p>updated</p>", message: "contributor save" }),
      },
    );
    const resp = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${contributorsDocId}/contributors`,
      session1Token,
    );
    const { contributors } = await resp.json();
    expect(contributors.find((c: any) => c.id === testUser1.id)).toBeDefined();
  });

  it("should return unique contributors only (multiple saves by same user)", async () => {
    await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${contributorsDocId}`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({ html: "<p>save 2</p>", message: "save 2" }),
      },
    );
    await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${contributorsDocId}`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({ html: "<p>save 3</p>", message: "save 3" }),
      },
    );
    const resp = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/${contributorsDocId}/contributors`,
      session1Token,
    );
    const { contributors } = await resp.json();
    expect(contributors.filter((c: any) => c.id === testUser1.id).length).toBe(1);
  });

  it("should return empty array for non-existent document", async () => {
    const resp = await apiRequest(
      `/api/v1/spaces/${featuresTestSpaceId}/documents/non-existent-doc/contributors`,
      session1Token,
    );
    expect(resp.status).toBe(200);
    const { contributors } = await resp.json();
    expect(contributors).toEqual([]);
  });
});

describe("ACL API Tests - Non-existent Space 404s", () => {
  it("should return 404 for GET on non-existent space", async () => {
    const fakeSpaceId = crypto.randomUUID();
    const resp = await apiRequest(`/api/v1/spaces/${fakeSpaceId}`, session1Token);
    expect(resp.status).toBe(404);
    const data = await resp.json();
    expect(data.error).toContain("Space not found");
  });

  it("should return 404 for malformed space ID", async () => {
    const resp = await apiRequest(`/api/v1/spaces/not-a-valid-id`, session1Token);
    expect(resp.status).toBe(404);
  });

  it("should return 404 when creating a document in a non-existent space", async () => {
    const fakeSpaceId = crypto.randomUUID();
    const resp = await apiRequest(
      `/api/v1/spaces/${fakeSpaceId}/documents`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({ content: "# Test", properties: { title: "Test" } }),
      },
    );
    expect(resp.status).toBe(404);
  });

  it("should return 404 when listing categories in a non-existent space", async () => {
    const fakeSpaceId = crypto.randomUUID();
    const resp = await apiRequest(
      `/api/v1/spaces/${fakeSpaceId}/categories`,
      session1Token,
    );
    expect(resp.status).toBe(404);
  });

  it("should return 404 when fetching document history in a non-existent space", async () => {
    const fakeSpaceId = crypto.randomUUID();
    const fakeDocId = crypto.randomUUID();
    const resp = await apiRequest(
      `/api/v1/spaces/${fakeSpaceId}/documents/${fakeDocId}/revisions`,
      session1Token,
    );
    expect(resp.status).toBe(404);
  });

  it("should return 404 for contributors endpoint on non-existent space", async () => {
    const fakeSpaceId = crypto.randomUUID();
    const fakeDocId = crypto.randomUUID();
    const resp = await apiRequest(
      `/api/v1/spaces/${fakeSpaceId}/documents/${fakeDocId}/contributors`,
      session1Token,
    );
    expect(resp.status).toBe(404);
  });
});

describe("ACL API Tests - Markdown content negotiation", () => {
  let mdTestSpaceId: string;
  let mdTestSpaceSlug: string;
  let mdOwnerToken: string;
  let mdViewerUser: { id: string; email: string; name: string };
  let mdViewerToken: string;
  let mdNonMemberUser: { id: string; email: string; name: string };
  let mdNonMemberToken: string;
  let testDocSlug: string;

  beforeAll(async () => {
    const ownerData = await createTestUser("MD Owner");
    mdOwnerToken = ownerData.token;

    const viewerData = await createTestUser("MD Viewer");
    mdViewerUser = {
      id: viewerData.userId,
      email: viewerData.email,
      name: viewerData.name,
    };
    mdViewerToken = viewerData.token;

    const nonMemberData = await createTestUser("MD Non-Member");
    mdNonMemberUser = {
      id: nonMemberData.userId,
      email: nonMemberData.email,
      name: nonMemberData.name,
    };
    mdNonMemberToken = nonMemberData.token;

    const spaceResponse = await apiRequest("/api/v1/spaces", mdOwnerToken, {
      method: "POST",
      body: JSON.stringify({
        name: "MD Test Space",
        slug: `md-test-space-${Date.now()}`,
      }),
    });
    const spaceData = await spaceResponse.json();
    mdTestSpaceId = spaceData.space.id;
    mdTestSpaceSlug = spaceData.space.slug;

    const docResponse = await apiRequest(
      `/api/v1/spaces/${mdTestSpaceId}/documents`,
      mdOwnerToken,
      {
        method: "POST",
        body: JSON.stringify({
          content:
            "# Test Markdown Export\n\nThis document tests .md endpoint access control.",
          properties: { title: "Test Markdown Export" },
        }),
      },
    );
    const docData = await docResponse.json();
    testDocSlug = docData.document.slug;
  });

  it("should allow space owner to access document as markdown", async () => {
    const response = await fetch(`${BASE_URL}/${mdTestSpaceSlug}/doc/${testDocSlug}`, {
      headers: {
        Accept: "text/markdown",
        Cookie: `vektor.session_token=${mdOwnerToken}`,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/markdown");
    const content = await response.text();
    expect(content).toContain("Test Markdown Export");
    expect(content).toContain("slug: " + testDocSlug);
  });

  it("should allow space member with viewer role to access document as markdown", async () => {
    await apiRequest(`/api/v1/spaces/${mdTestSpaceId}/permissions`, mdOwnerToken, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        userId: mdViewerUser.id,
        action: "grant",
      }),
    });

    const response = await fetch(`${BASE_URL}/${mdTestSpaceSlug}/doc/${testDocSlug}`, {
      headers: {
        Accept: "text/markdown",
        Cookie: `vektor.session_token=${mdViewerToken}`,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/markdown");
  });

  it("should deny non-member access to document as markdown", async () => {
    const response = await fetch(`${BASE_URL}/${mdTestSpaceSlug}/doc/${testDocSlug}`, {
      headers: {
        Accept: "text/markdown",
        Cookie: `vektor.session_token=${mdNonMemberToken}`,
      },
    });

    expect(response.status).toBe(403);
  });

  it("should deny access after member is removed from space", async () => {
    await apiRequest(`/api/v1/spaces/${mdTestSpaceId}/permissions`, mdOwnerToken, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        userId: mdViewerUser.id,
        action: "revoke",
      }),
    });

    const response = await fetch(`${BASE_URL}/${mdTestSpaceSlug}/doc/${testDocSlug}`, {
      headers: {
        Accept: "text/markdown",
        Cookie: `vektor.session_token=${mdViewerToken}`,
      },
    });

    expect(response.status).toBe(403);
  });

  it("should allow document-specific member access to markdown export", async () => {
    const docResponse = await apiRequest(
      `/api/v1/spaces/${mdTestSpaceId}/documents`,
      mdOwnerToken,
      {
        method: "POST",
        body: JSON.stringify({
          content: "# Document-specific Access Test",
          properties: { title: "Document-specific Access Test" },
        }),
      },
    );
    const docData = await docResponse.json();
    const docSlug = docData.document.slug;
    const docId = docData.document.id;

    await apiRequest(`/api/v1/spaces/${mdTestSpaceId}/permissions`, mdOwnerToken, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        userId: mdNonMemberUser.id,
        resourceType: "document",
        resourceId: docId,
        action: "grant",
      }),
    });

    const response = await fetch(`${BASE_URL}/${mdTestSpaceSlug}/doc/${docSlug}`, {
      headers: {
        Accept: "text/markdown",
        Cookie: `vektor.session_token=${mdNonMemberToken}`,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/markdown");
  });

  it("should apply the route's normal unauthenticated redirect", async () => {
    const response = await fetch(`${BASE_URL}/${mdTestSpaceSlug}/doc/${testDocSlug}`, {
      headers: { Accept: "text/markdown" },
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
  });

  it("should return 404 for non-existent document slug", async () => {
    const response = await fetch(
      `${BASE_URL}/${mdTestSpaceSlug}/doc/non-existent-slug-12345`,
      {
        headers: {
          Accept: "text/markdown",
          Cookie: `vektor.session_token=${mdOwnerToken}`,
        },
      },
    );
    expect(response.status).toBe(404);
  });

  it("should return 404 for non-existent space slug", async () => {
    const response = await fetch(`${BASE_URL}/non-existent-space/doc/${testDocSlug}`, {
      headers: {
        Accept: "text/markdown",
        Cookie: `vektor.session_token=${mdOwnerToken}`,
      },
    });
    expect(response.status).toBe(404);
  });
});

describe("ACL API Tests - Public Access with Owner Override", () => {
  let publicTestSpaceId: string;
  let publicTestSpaceSlug: string;
  let ownerUser: { id: string; token: string };
  let publicTestDocId: string;
  let publicTestDocSlug: string;

  beforeAll(async () => {
    const ownerData = await createTestUser("Public Test Owner");
    ownerUser = { id: ownerData.userId, token: ownerData.token };

    const spaceSlug = `public-test-${Date.now()}`;
    const spaceResponse = await apiRequest("/api/v1/spaces", ownerUser.token, {
      method: "POST",
      body: JSON.stringify({ name: "Public Access Test Space", slug: spaceSlug }),
    });
    const spaceData = await spaceResponse.json();
    publicTestSpaceId = spaceData.space.id;
    publicTestSpaceSlug = spaceSlug;

    const docResponse = await apiRequest(
      `/api/v1/spaces/${publicTestSpaceId}/documents`,
      ownerUser.token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "<p>Public test document</p>",
          properties: { title: "Public Test Document", slug: "public-test-doc" },
        }),
      },
    );
    const docData = await docResponse.json();
    publicTestDocId = docData.document.id;
    publicTestDocSlug = docData.document.slug;

    await apiRequest(`/api/v1/spaces/${publicTestSpaceId}/permissions`, ownerUser.token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        groupId: "public",
        action: "grant",
      }),
    });
  });

  it("should allow owner to access space settings despite public viewer access", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${publicTestSpaceId}`,
      ownerUser.token,
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe(publicTestSpaceId);
  });

  it("should allow owner to list members despite public access", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${publicTestSpaceId}/permissions?type=role`,
      ownerUser.token,
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data.permissions)).toBe(true);
    expect(data.permissions.length).toBeGreaterThan(0);
  });

  it("should allow owner to add members despite public access", async () => {
    const newUser = await createTestUser("New Member");
    const response = await apiRequest(
      `/api/v1/spaces/${publicTestSpaceId}/permissions`,
      ownerUser.token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "editor",
          userId: newUser.userId,
          action: "grant",
        }),
      },
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.permission.userId).toBe(newUser.userId);
    expect(data.permission.permission).toBe("editor");
  });

  it("should allow owner to create documents despite public viewer access", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${publicTestSpaceId}/documents`,
      ownerUser.token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "<p>Owner created document</p>",
          properties: { title: "Owner Document" },
        }),
      },
    );
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.document.properties.title).toBe("Owner Document");
  });

  it("should allow owner to edit documents despite public viewer access", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${publicTestSpaceId}/documents/${publicTestDocId}`,
      ownerUser.token,
      {
        method: "PUT",
        body: JSON.stringify({ content: "<p>Updated by owner</p>" }),
      },
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.document).toBeDefined();
  });

  it("should allow owner to delete documents despite public viewer access", async () => {
    const createResponse = await apiRequest(
      `/api/v1/spaces/${publicTestSpaceId}/documents`,
      ownerUser.token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "<p>Document to delete</p>",
          properties: { title: "Delete Me" },
        }),
      },
    );
    const createData = await createResponse.json();
    const docToDelete = createData.document.id;

    const response = await apiRequest(
      `/api/v1/spaces/${publicTestSpaceId}/documents/${docToDelete}`,
      ownerUser.token,
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);
  });

  it("should allow unauthenticated users to access public documents via frontend route", async () => {
    const response = await fetch(
      `${BASE_URL}/${publicTestSpaceSlug}/doc/${publicTestDocSlug}`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Public Test Document");
  });
});
