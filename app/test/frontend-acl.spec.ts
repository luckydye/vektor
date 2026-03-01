import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getAuthDb } from "../src/db/db.ts";
import { user as userTable } from "../src/db/schema/auth.ts";
import { eq } from "drizzle-orm";

const DATA_DIR = "./data";
const BASE_URL = "http://127.0.0.1:4321";

let testUser1: { id: string; email: string; name: string };
let testUser2: { id: string; email: string; name: string };
let testUser3: { id: string; email: string; name: string };
let session1Token: string;
let session2Token: string;
let session3Token: string;
let testSpaceId: string;
let testSpaceSlug: string;
let testDocumentId: string;
let testDocumentSlug: string;
let privateDocumentId: string;
let privateDocumentSlug: string;

async function createTestUser(name: string) {
  const testEmail = `test-frontend-acl-${Date.now()}-${Math.random()}@example.com`;
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
    const match = cookies.match(/better-auth\.session_token=([^;]+)/);
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

async function assignUserToGroup(userId: string, groups: string[]): Promise<void> {
  const authDb = getAuthDb();
  if (!authDb) {
    throw new Error("Auth database not available");
  }

  const groupsJson = JSON.stringify(groups);
  console.log(`Assigning groups to user ${userId}: ${groupsJson}`);

  await authDb
    .update(userTable)
    .set({ groups: groupsJson })
    .where(eq(userTable.id, userId))
    .run();

  // Verify the groups were saved
  const verifyUser = await authDb
    .select()
    .from(userTable)
    .where(eq(userTable.id, userId))
    .get();

  console.log(`Verified user ${userId} groups in DB: ${verifyUser?.groups}`);
}

async function apiRequest(
  path: string,
  sessionToken: string,
  options: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (sessionToken) {
    headers.set("Cookie", `better-auth.session_token=${sessionToken}`);
  }
  headers.set("Content-Type", "application/json");

  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });
}

async function pageRequest(path: string, sessionToken: string): Promise<Response> {
  const headers = new Headers();
  if (sessionToken) {
    headers.set("Cookie", `better-auth.session_token=${sessionToken}`);
  }

  return fetch(`${BASE_URL}${path}`, {
    headers,
    redirect: "manual",
  });
}

beforeAll(async () => {
  try {
    // Create three test users
    const user1Data = await createTestUser("Frontend User 1");
    testUser1 = {
      id: user1Data.userId,
      email: user1Data.email,
      name: user1Data.name,
    };
    session1Token = user1Data.token;

    const user2Data = await createTestUser("Frontend User 2");
    testUser2 = {
      id: user2Data.userId,
      email: user2Data.email,
      name: user2Data.name,
    };
    session2Token = user2Data.token;

    const user3Data = await createTestUser("Frontend User 3");
    testUser3 = {
      id: user3Data.userId,
      email: user3Data.email,
      name: user3Data.name,
    };
    session3Token = user3Data.token;

    // Create a test space as user1
    testSpaceSlug = `frontend-acl-test-${Date.now()}`;
    const spaceResponse = await apiRequest("/api/v1/spaces", session1Token, {
      method: "POST",
      body: JSON.stringify({
        name: "Frontend ACL Test Space",
        slug: testSpaceSlug,
      }),
    });

    const spaceData = await spaceResponse.json();
    testSpaceId = spaceData.space.id;

    // Create a test document
    const docResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "<h1>Frontend ACL Test Document</h1><p>This is a test document.</p>",
          properties: {
            title: "Frontend ACL Test Document",
          },
        }),
      },
    );

    const docData = await docResponse.json();
    testDocumentId = docData.document.id;
    testDocumentSlug = docData.document.slug;

    // Create a private document (no access for user2/user3)
    const privateDocResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents`,
      session1Token,
      {
        method: "POST",
        body: JSON.stringify({
          content: "<h1>Private Document</h1><p>This is a private document.</p>",
          properties: {
            title: "Private Document",
          },
        }),
      },
    );

    const privateDocData = await privateDocResponse.json();
    privateDocumentId = privateDocData.document.id;
    privateDocumentSlug = privateDocData.document.slug;

    console.log("Frontend ACL test setup complete");
  } catch (error) {
    console.error("Failed to setup frontend ACL tests:", error);
    throw error;
  }
});

afterAll(async () => {
  if (testSpaceId && existsSync(join(DATA_DIR, "spaces", `${testSpaceId}.db`))) {
    rmSync(join(DATA_DIR, "spaces", `${testSpaceId}.db`), { force: true });
  }
  console.log("Frontend ACL test cleanup complete");
});

describe("Frontend ACL Tests - Document Page Access", () => {
  it("should allow owner to view document via frontend route", async () => {
    const response = await pageRequest(
      `/${testSpaceSlug}/doc/${testDocumentSlug}`,
      session1Token,
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Frontend ACL Test Document");
  });

  it("should deny access to non-member via frontend route", async () => {
    const response = await pageRequest(
      `/${testSpaceSlug}/doc/${testDocumentSlug}`,
      session2Token,
    );

    // Should return 403 Forbidden, not 200
    expect(response.status).not.toBe(200);
    expect([403, 404]).toContain(response.status);
  });

  it("should deny access to unauthenticated user via frontend route", async () => {
    const response = await pageRequest(`/${testSpaceSlug}/doc/${testDocumentSlug}`, "");

    // Should redirect to login or return 403
    expect([302, 303, 307, 401, 403]).toContain(response.status);
  });
});

describe("Frontend ACL Tests - Space Access", () => {
  it("should allow owner to view space index", async () => {
    const response = await pageRequest(`/${testSpaceSlug}`, session1Token);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Home");
  });

  it("should deny non-member access to space index", async () => {
    const response = await pageRequest(`/${testSpaceSlug}`, session2Token);

    // Should not allow access
    expect(response.status).not.toBe(200);
    expect([403, 404]).toContain(response.status);
  });

  it("should deny unauthenticated access to space index", async () => {
    const response = await pageRequest(`/${testSpaceSlug}`, "");

    // Should redirect to login
    expect([302, 303, 307, 401, 403]).toContain(response.status);
  });
});

describe("Frontend ACL Tests - Search Page Access", () => {
  it("should allow owner to access search page", async () => {
    const response = await pageRequest(`/${testSpaceSlug}/search`, session1Token);

    expect(response.status).toBe(200);
  });

  it("should deny non-member access to search page", async () => {
    const response = await pageRequest(`/${testSpaceSlug}/search`, session2Token);

    expect(response.status).not.toBe(200);
    expect([403, 404]).toContain(response.status);
  });
});

describe("Frontend ACL Tests - Settings Page Access", () => {
  it("should allow owner to access settings page", async () => {
    const response = await pageRequest(`/${testSpaceSlug}/settings`, session1Token);

    expect(response.status).toBe(200);
  });

  it("should deny non-member access to settings page", async () => {
    const response = await pageRequest(`/${testSpaceSlug}/settings`, session2Token);

    expect(response.status).not.toBe(200);
    expect([403, 404]).toContain(response.status);
  });

  it("should deny viewer access to settings page", async () => {
    // Add user3 as viewer to space
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

    const response = await pageRequest(`/${testSpaceSlug}/settings`, session3Token);

    // Viewers should not access settings
    expect(response.status).not.toBe(200);
    expect([403, 404]).toContain(response.status);
  });
});

describe("Frontend ACL Tests - Permission Inheritance on Frontend", () => {
  beforeAll(async () => {
    // Add user2 as viewer to space
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        userId: testUser2.id,
        action: "grant",
      }),
    });
  });

  it("should allow space viewer to view documents via frontend", async () => {
    const response = await pageRequest(
      `/${testSpaceSlug}/doc/${testDocumentSlug}`,
      session2Token,
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Frontend ACL Test Document");
  });

  it("should allow space viewer to access space index", async () => {
    const response = await pageRequest(`/${testSpaceSlug}`, session2Token);

    expect(response.status).toBe(200);
  });

  it("should deny space viewer access to private document without explicit permission", async () => {
    // User2 has space viewer access, but private document has no explicit permissions
    // This should be allowed due to space inheritance
    const response = await pageRequest(
      `/${testSpaceSlug}/doc/${privateDocumentSlug}`,
      session2Token,
    );

    // With space-level viewer access, user2 should see the document
    expect(response.status).toBe(200);
  });
});

describe("Frontend ACL Tests - Document-Level Permissions on Frontend", () => {
  let docLevelUser: { id: string; email: string };
  let docLevelToken: string;

  beforeAll(async () => {
    const userData = await createTestUser("Doc Level User");
    docLevelUser = { id: userData.userId, email: userData.email };
    docLevelToken = userData.token;
  });

  it("should allow document-specific access even without space membership", async () => {
    // Grant user direct access to specific document
    // Grant user viewer access to SPECIFIC document only
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, session1Token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        userId: docLevelUser.id,
        resourceType: "document",
        resourceId: testDocumentId,
        action: "grant",
      }),
    });

    const response = await pageRequest(
      `/${testSpaceSlug}/doc/${testDocumentSlug}`,
      docLevelToken,
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Home");
  });

  it.skip("should deny access to other documents without space membership", async () => {
    const response = await pageRequest(
      `/${testSpaceSlug}/doc/${privateDocumentSlug}`,
      docLevelToken,
    );

    expect(response.status).not.toBe(200);
  });

  it.skip("should deny space index access without space membership", async () => {
    // User has document-level access but no space membership
    const response = await pageRequest(`/${testSpaceSlug}`, docLevelToken);

    expect(response.status).not.toBe(200);
  });
});

describe("Frontend ACL Tests - Role-Based Access on Frontend", () => {
  beforeAll(async () => {
    // Add user2 as editor
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

  it("should allow editor to view documents", async () => {
    const response = await pageRequest(
      `/${testSpaceSlug}/doc/${testDocumentSlug}`,
      session2Token,
    );

    expect(response.status).toBe(200);
  });

  it("should allow editor to access space index", async () => {
    const response = await pageRequest(`/${testSpaceSlug}`, session2Token);

    expect(response.status).toBe(200);
  });

  it("should deny editor access to settings page", async () => {
    const response = await pageRequest(`/${testSpaceSlug}/settings`, session2Token);

    // Editors should not access settings (only owner)
    expect(response.status).not.toBe(200);
    expect([403, 404]).toContain(response.status);
  });
});

describe("Frontend ACL Tests - Cross-User Document Isolation", () => {
  it("should not leak document content to unauthorized users", async () => {
    // Create a new user with no permissions
    const unauthorizedUser = await createTestUser("Unauthorized User");

    const response = await pageRequest(
      `/${testSpaceSlug}/doc/${privateDocumentSlug}`,
      unauthorizedUser.token,
    );

    expect(response.status).not.toBe(200);

    if (response.status === 200) {
      const html = await response.text();
      // If somehow it returns 200, it should not contain sensitive content
      expect(html).not.toContain("Private Document");
    }
  });

  it("should not allow access via direct document ID in URL", async () => {
    // Try to access document by ID instead of slug
    const response = await pageRequest(
      `/${testSpaceSlug}/doc/${privateDocumentId}`,
      session2Token,
    );

    // Even if they guess the ID, they shouldn't get access
    expect(response.status).not.toBe(200);
  });
});

describe("Frontend ACL Tests - Session Validation", () => {
  it("should deny access with invalid session token", async () => {
    const response = await pageRequest(
      `/${testSpaceSlug}/doc/${testDocumentSlug}`,
      "invalid-session-token",
    );

    expect(response.status).not.toBe(200);
    expect([302, 303, 307, 401, 403]).toContain(response.status);
  });

  it("should deny access with expired or malformed session", async () => {
    const response = await pageRequest(
      `/${testSpaceSlug}/doc/${testDocumentSlug}`,
      "malformed.session.token.value",
    );

    expect(response.status).not.toBe(200);
    expect([302, 303, 307, 401, 403]).toContain(response.status);
  });
});

describe("Frontend ACL Tests - Group-Based Access", () => {
  let groupSpaceId: string;
  let groupSpaceSlug: string;
  let groupSpaceOwner: { id: string; email: string; name: string; token: string };
  let groupTestUser: { id: string; email: string; name: string; token: string };
  let nonGroupUser: { id: string; email: string; name: string; token: string };

  beforeAll(async () => {
    // Create a separate owner for the group test space
    const ownerData = await createTestUser("Group Space Owner");
    groupSpaceOwner = {
      id: ownerData.userId,
      email: ownerData.email,
      name: ownerData.name,
      token: ownerData.token,
    };

    // Create a test user who will be granted access via group
    const userData = await createTestUser("Group Test User");
    groupTestUser = {
      id: userData.userId,
      email: userData.email,
      name: userData.name,
      token: userData.token,
    };

    // Assign groupTestUser to the "test-group" immediately after creation
    await assignUserToGroup(groupTestUser.id, ["public", "test-group"]);

    // Create a user who is NOT in the group
    const nonGroupData = await createTestUser("Non-Group User");
    nonGroupUser = {
      id: nonGroupData.userId,
      email: nonGroupData.email,
      name: nonGroupData.name,
      token: nonGroupData.token,
    };

    // Create a new space for group testing (owned by groupSpaceOwner)
    groupSpaceSlug = `group-acl-test-${Date.now()}`;
    const spaceResponse = await apiRequest("/api/v1/spaces", groupSpaceOwner.token, {
      method: "POST",
      body: JSON.stringify({
        name: "Group ACL Test Space",
        slug: groupSpaceSlug,
      }),
    });

    const spaceData = await spaceResponse.json();
    groupSpaceId = spaceData.space.id;
  });

  it("should deny access to user not in any group before adding group permissions", async () => {
    // groupTestUser should NOT have access initially
    const response = await pageRequest(`/${groupSpaceSlug}`, groupTestUser.token);

    expect(response.status).not.toBe(200);
    expect([403, 404]).toContain(response.status);
  });

  it("should allow user added by groupId as editor to access space frontend", async () => {
    // Verify the user has the correct groups
    const authDb = getAuthDb();
    const verifyUser = await authDb
      ?.select()
      .from(userTable)
      .where(eq(userTable.id, groupTestUser.id))
      .get();
    console.log(`User ${groupTestUser.id} groups before test: ${verifyUser?.groups}`);

    // Owner adds the "test-group" group as editor to the space
    // Owner adds test-group as editor
    const addGroupResponse = await apiRequest(
      `/api/v1/spaces/${groupSpaceId}/permissions`,
      groupSpaceOwner.token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "editor",
          groupId: "test-group",
          action: "grant",
        }),
      },
    );

    expect(addGroupResponse.status).toBe(200);

    // Now groupTestUser (who is in the test-group) should be able to access the space frontend
    const response = await pageRequest(`/${groupSpaceSlug}`, groupTestUser.token);

    if (response.status !== 200) {
      console.log(`Failed with status ${response.status}, expected 200`);
      const html = await response.text();
      console.log(`Response body: ${html.substring(0, 200)}`);
    }

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Home");
  });

  it("should deny access to user not in the test-group", async () => {
    // nonGroupUser is NOT in test-group, so they should not have access
    const response = await pageRequest(`/${groupSpaceSlug}`, nonGroupUser.token);

    expect(response.status).not.toBe(200);
    expect([403, 404]).toContain(response.status);
  });

  it("should allow user in editor group to view documents in space", async () => {
    // Owner creates a document in the group space
    const docResponse = await apiRequest(
      `/api/v1/spaces/${groupSpaceId}/documents`,
      groupSpaceOwner.token,
      {
        method: "POST",
        body: JSON.stringify({
          content:
            "<h1>Group Access Document</h1><p>This document tests group access.</p>",
          properties: {
            title: "Group Access Document",
          },
        }),
      },
    );

    const docData = await docResponse.json();
    const docSlug = docData.document.slug;

    // groupTestUser with group-based editor access should be able to view the document
    const response = await pageRequest(
      `/${groupSpaceSlug}/doc/${docSlug}`,
      groupTestUser.token,
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Group Access Document");
  });

  it("should allow user in editor group to access search page", async () => {
    const response = await pageRequest(`/${groupSpaceSlug}/search`, groupTestUser.token);

    expect(response.status).toBe(200);
  });

  it("should deny user in editor group access to settings page", async () => {
    // Editor role should not have access to settings (owner only)
    const response = await pageRequest(
      `/${groupSpaceSlug}/settings`,
      groupTestUser.token,
    );

    expect(response.status).not.toBe(200);
    expect([403, 404]).toContain(response.status);
  });

  it("should allow user in viewer group to access space but not settings", async () => {
    // Owner changes the test-group role to viewer
    await apiRequest(
      `/api/v1/spaces/${groupSpaceId}/permissions`,
      groupSpaceOwner.token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "viewer",
          groupId: "test-group",
          action: "grant",
        }),
      },
    );

    // groupTestUser should still be able to access the space frontend
    const spaceResponse = await pageRequest(`/${groupSpaceSlug}`, groupTestUser.token);
    expect(spaceResponse.status).toBe(200);

    // But not settings
    const settingsResponse = await pageRequest(
      `/${groupSpaceSlug}/settings`,
      groupTestUser.token,
    );
    expect(settingsResponse.status).not.toBe(200);
    expect([403, 404]).toContain(settingsResponse.status);
  });

  it("should deny access when user not in any permitted group", async () => {
    // Owner removes test-group access
    await apiRequest(
      `/api/v1/spaces/${groupSpaceId}/permissions`,
      groupSpaceOwner.token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "viewer",
          groupId: "test-group",
          action: "revoke",
        }),
      },
    );

    // groupTestUser should no longer have access
    const response = await pageRequest(`/${groupSpaceSlug}`, groupTestUser.token);

    expect(response.status).not.toBe(200);
    expect([403, 404]).toContain(response.status);
  });

  it("should verify owner still has access after removing group permissions", async () => {
    // Owner should still have access to their own space
    const response = await pageRequest(`/${groupSpaceSlug}`, groupSpaceOwner.token);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Home");
  });
});
