import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = "./data";
const BASE_URL = "http://127.0.0.1:4321";

let _ownerUser: { id: string; email: string; name: string };
let editorUser: { id: string; email: string; name: string };
let viewerUser: { id: string; email: string; name: string };
let ownerToken: string;
let editorToken: string;
let viewerToken: string;
let testSpaceId: string;
let testDocumentId: string;

async function createTestUser(name: string) {
  const testEmail = `test-features-${Date.now()}-${Math.random()}@example.com`;
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

beforeAll(async () => {
  try {
    // Create test users
    const ownerData = await createTestUser("Feature Test Owner");
    _ownerUser = {
      id: ownerData.userId,
      email: ownerData.email,
      name: ownerData.name,
    };
    ownerToken = ownerData.token;

    const editorData = await createTestUser("Feature Test Editor");
    editorUser = {
      id: editorData.userId,
      email: editorData.email,
      name: editorData.name,
    };
    editorToken = editorData.token;

    const viewerData = await createTestUser("Feature Test Viewer");
    viewerUser = {
      id: viewerData.userId,
      email: viewerData.email,
      name: viewerData.name,
    };
    viewerToken = viewerData.token;

    // Create a test space as owner
    const uniqueSlug = `features-test-space-${Date.now()}`;
    const spaceResponse = await apiRequest("/api/v1/spaces", ownerToken, {
      method: "POST",
      body: JSON.stringify({
        name: "Features Test Space",
        slug: uniqueSlug,
      }),
    });

    if (!spaceResponse.ok) {
      const errorText = await spaceResponse.text();
      throw new Error(`Failed to create space (${spaceResponse.status}): ${errorText}`);
    }

    const spaceData = await spaceResponse.json();
    testSpaceId = spaceData.space.id;

    // Add editor user to space with editor role
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, ownerToken, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "editor",
        userId: editorUser.id,
        action: "grant",
      }),
    });

    // Add viewer user to space with viewer role
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, ownerToken, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        userId: viewerUser.id,
        action: "grant",
      }),
    });

    // Create a test document
    const docResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents`,
      ownerToken,
      {
        method: "POST",
        body: JSON.stringify({
          content:
            "# Features Test Document\n\nThis is a test document for feature permissions.",
          properties: {
            title: "Features Test Document",
          },
        }),
      },
    );

    const docData = await docResponse.json();
    testDocumentId = docData.document.id;
  } catch (error) {
    console.error("Failed to setup feature permissions tests:", error);
    throw error;
  }
});

afterAll(async () => {
  if (testSpaceId && existsSync(join(DATA_DIR, "spaces", `${testSpaceId}.db`))) {
    rmSync(join(DATA_DIR, "spaces", `${testSpaceId}.db`), { force: true });
  }
});

describe("Permissions API - Get Current User Permissions", () => {
  it("should return all features and owner role for owner", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions/me`,
      ownerToken,
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
      `/api/v1/spaces/${testSpaceId}/permissions/me`,
      editorToken,
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
      `/api/v1/spaces/${testSpaceId}/permissions/me`,
      viewerToken,
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
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/comments`,
      ownerToken,
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
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/comments`,
      editorToken,
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
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/comments`,
      viewerToken,
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
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/comments`,
      viewerToken,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.comments).toBeDefined();
    expect(Array.isArray(data.comments)).toBe(true);
  });

  it("should require reference for top-level comments", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/comments`,
      ownerToken,
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
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/revisions`,
      ownerToken,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.revisions).toBeDefined();
  });

  it("should allow editor to view document history", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/revisions`,
      editorToken,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.revisions).toBeDefined();
  });

  it("should deny viewer from viewing document history by default", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/revisions`,
      viewerToken,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });
});

describe("Permissions API - Audit Logs Feature", () => {
  it("should allow owner to view space audit logs", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/audit-logs`,
      ownerToken,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.auditLogs).toBeDefined();
  });

  it("should allow owner to view document audit logs", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/audit-logs`,
      ownerToken,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.auditLogs).toBeDefined();
  });

  it("should deny editor from viewing space audit logs by default", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/audit-logs`,
      editorToken,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });

  it("should deny editor from viewing document audit logs by default", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/audit-logs`,
      editorToken,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });

  it("should deny viewer from viewing space audit logs", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/audit-logs`,
      viewerToken,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });

  it("should deny viewer from viewing document audit logs", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/audit-logs`,
      viewerToken,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });
});

describe("Permissions API - Unified Permissions Management", () => {
  it("should allow owner to list all permissions", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      ownerToken,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.permissions).toBeDefined();
    expect(Array.isArray(data.permissions)).toBe(true);
  });

  it("should allow owner to list only role permissions", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions?type=role`,
      ownerToken,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.permissions).toBeDefined();
    const rolePerms = data.permissions.filter((p: any) => p.type === "role");
    expect(rolePerms.length).toBeGreaterThan(0);
  });

  it("should allow owner to list only feature permissions", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions?type=feature`,
      ownerToken,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.permissions).toBeDefined();
  });

  it("should deny editor from listing permissions", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      editorToken,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });

  it("should deny viewer from listing permissions", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      viewerToken,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });
});

describe("Permissions API - Grant/Deny/Revoke Features", () => {
  it("should allow owner to grant feature to user", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      ownerToken,
      {
        method: "POST",
        body: JSON.stringify({
          type: "feature",
          roleOrFeature: "comment",
          userId: viewerUser.id,
          action: "grant",
        }),
      },
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.permission).toBeDefined();
    expect(data.permission.userId).toBe(viewerUser.id);
    expect(data.permission.resourceId).toBe("comment");
  });

  it("should allow viewer to comment after feature grant", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/comments`,
      viewerToken,
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
      `/api/v1/spaces/${testSpaceId}/permissions/me`,
      viewerToken,
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.features.comment).toBe(true);
  });

  it("should allow owner to deny feature from user", async () => {
    // First grant view_history to editor, then deny it
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, ownerToken, {
      method: "POST",
      body: JSON.stringify({
        type: "feature",
        roleOrFeature: "view_history",
        userId: editorUser.id,
        action: "deny",
      }),
    });

    // Verify editor can no longer view history
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/revisions`,
      editorToken,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });

  it("should allow owner to revoke feature (revert to default)", async () => {
    // Revoke the deny on view_history for editor
    const revokeResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      ownerToken,
      {
        method: "POST",
        body: JSON.stringify({
          type: "feature",
          roleOrFeature: "view_history",
          userId: editorUser.id,
          action: "revoke",
        }),
      },
    );

    expect(revokeResponse.ok).toBe(true);

    // Verify editor can view history again
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/revisions`,
      editorToken,
    );

    expect(response.ok).toBe(true);
  });

  it("should reject invalid feature name", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      ownerToken,
      {
        method: "POST",
        body: JSON.stringify({
          type: "feature",
          roleOrFeature: "invalid_feature",
          userId: viewerUser.id,
          action: "grant",
        }),
      },
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
  });

  it("should reject invalid action", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      ownerToken,
      {
        method: "POST",
        body: JSON.stringify({
          type: "feature",
          roleOrFeature: "comment",
          userId: viewerUser.id,
          action: "invalid_action",
        }),
      },
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
  });

  it("should reject request without userId or groupId", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/permissions`,
      ownerToken,
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
      `/api/v1/spaces/${testSpaceId}/permissions`,
      ownerToken,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "editor",
          userId: viewerUser.id,
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
      `/api/v1/spaces/${testSpaceId}/permissions`,
      ownerToken,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "editor",
          userId: viewerUser.id,
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
      `/api/v1/spaces/${testSpaceId}/permissions`,
      ownerToken,
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
      `/api/v1/spaces/${testSpaceId}/permissions`,
      ownerToken,
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
    // Grant view_history to public group
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, ownerToken, {
      method: "POST",
      body: JSON.stringify({
        type: "feature",
        roleOrFeature: "view_history",
        groupId: "public",
        action: "grant",
      }),
    });

    // User-specific deny should take precedence
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, ownerToken, {
      method: "POST",
      body: JSON.stringify({
        type: "feature",
        roleOrFeature: "view_history",
        userId: viewerUser.id,
        action: "deny",
      }),
    });

    // Viewer should NOT have view_history (user deny takes precedence)
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}/revisions`,
      viewerToken,
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);

    // Clean up
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, ownerToken, {
      method: "POST",
      body: JSON.stringify({
        type: "feature",
        roleOrFeature: "view_history",
        userId: viewerUser.id,
        action: "revoke",
      }),
    });
    await apiRequest(`/api/v1/spaces/${testSpaceId}/permissions`, ownerToken, {
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
