import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSessionApiRequest,
  createTestUser,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7493;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);
const makeUser = (name: string) => createTestUser(BASE_URL, name, "test-escalation");

let serverProcess: TestServerProcess;

let owner: { id: string; token: string };
let editor: { id: string; token: string };
let bystander: { id: string; token: string };
let newcomer: { id: string; email: string; token: string };
let spaceId: string;
let documentId: string;
let childDocumentId: string;

interface PermissionBody {
  type: "role" | "feature";
  roleOrFeature: string;
  action: string;
  userId?: string;
  groupId?: string;
  resourceType?: string;
  resourceId?: string;
}

function postPermission(token: string, body: PermissionBody): Promise<Response> {
  return apiRequest(`/api/v1/spaces/${spaceId}/permissions`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function roleOf(token: string): Promise<string | null> {
  const response = await apiRequest(`/api/v1/spaces/${spaceId}/permissions/me`, token);
  expect(response.status).toBe(200);
  return (await response.json()).role;
}

async function allRoleEntries(): Promise<
  Array<{ userId?: string; groupId?: string; permission: string; resourceType: string }>
> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/permissions?type=role&allResources=true`,
    owner.token,
  );
  expect(response.status).toBe(200);
  const data = await response.json();
  return data.permissions.map(
    (entry: { permission: Record<string, string> }) => entry.permission,
  );
}

async function expectEditorStillNotOwner(): Promise<void> {
  expect(await roleOf(editor.token)).toBe("editor");

  const ownerEntries = (await allRoleEntries()).filter(
    (entry) => entry.userId === editor.id && entry.permission === "owner",
  );
  expect(ownerEntries).toEqual([]);

  const rename = await apiRequest(`/api/v1/spaces/${spaceId}`, editor.token, {
    method: "PATCH",
    body: JSON.stringify({ name: "Escalated Space" }),
  });
  expect(rename.status).toBe(403);
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "escalation-test-secret-do-not-use",
  });
  await waitForServer(BASE_URL);

  const ownerUser = await makeUser("Escalation Owner");
  owner = { id: ownerUser.userId, token: ownerUser.token };
  const editorUser = await makeUser("Escalation Editor");
  editor = { id: editorUser.userId, token: editorUser.token };
  const bystanderUser = await makeUser("Escalation Bystander");
  bystander = { id: bystanderUser.userId, token: bystanderUser.token };
  const newcomerUser = await makeUser("Escalation Newcomer");
  newcomer = {
    id: newcomerUser.userId,
    email: newcomerUser.email,
    token: newcomerUser.token,
  };

  const spaceResponse = await apiRequest("/api/v1/spaces", owner.token, {
    method: "POST",
    body: JSON.stringify({
      name: "Escalation Space",
      slug: `escalation-space-${Date.now()}`,
    }),
  });
  if (!spaceResponse.ok) {
    throw new Error(`Failed to create space (${spaceResponse.status})`);
  }
  spaceId = (await spaceResponse.json()).space.id;

  const documentResponse = await apiRequest(
    `/api/v1/spaces/${spaceId}/documents`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        content: "# Escalation Parent",
        properties: { title: "Escalation Parent" },
      }),
    },
  );
  documentId = (await documentResponse.json()).document.id;

  const childResponse = await apiRequest(
    `/api/v1/spaces/${spaceId}/documents`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        content: "# Escalation Child",
        properties: { title: "Escalation Child" },
        parentId: documentId,
      }),
    },
  );
  childDocumentId = (await childResponse.json()).document.id;

  for (const [userId, role] of [
    [editor.id, "editor"],
    [bystander.id, "viewer"],
  ] as const) {
    const response = await postPermission(owner.token, {
      type: "role",
      roleOrFeature: role,
      userId,
      action: "grant",
    });
    if (!response.ok) {
      throw new Error(`Failed to grant ${role} (${response.status})`);
    }
  }
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

const ROLE_WRITE_ACTIONS = ["grant", "revoke", "deny", "elevate"] as const;

const SCOPES = [
  { resourceType: undefined, resourceId: undefined, label: "space" },
  { resourceType: "document", resourceId: () => documentId, label: "document" },
  {
    resourceType: "document_tree",
    resourceId: () => childDocumentId,
    label: "document-tree",
  },
] as const;

function expectedStatus(action: string, scope: string): number {
  if (action === "deny" || action === "elevate") return 400;
  if (action === "revoke" && scope !== "space") return 200;
  // Owner names authority over the space, so asking for it anywhere narrower is
  // a malformed request rather than a refused one.
  if (action === "grant" && scope !== "space") return 400;
  return 403;
}

describe("editor cannot obtain owner (issue #45)", () => {
  for (const action of ROLE_WRITE_ACTIONS) {
    for (const target of ["self", "another user"] as const) {
      for (const scope of SCOPES) {
        it(`refuses to make ${target} an owner via "${action}" at ${scope.label} level`, async () => {
          const response = await postPermission(editor.token, {
            type: "role",
            roleOrFeature: "owner",
            userId: target === "self" ? editor.id : bystander.id,
            action,
            ...(scope.resourceType
              ? { resourceType: scope.resourceType, resourceId: scope.resourceId?.() }
              : {}),
          });

          expect(response.status).toBe(expectedStatus(action, scope.label));
          await expectEditorStillNotOwner();

          if (target === "another user") {
            expect(await roleOf(bystander.token)).toBe("viewer");
          }
        });
      }
    }
  }

  it("keeps the space intact: the editor still cannot delete it", async () => {
    const escalate = await postPermission(editor.token, {
      type: "role",
      roleOrFeature: "owner",
      userId: editor.id,
      action: "deny",
    });
    expect(escalate.status).toBe(400);

    const deletion = await apiRequest(`/api/v1/spaces/${spaceId}`, editor.token, {
      method: "DELETE",
    });
    expect(deletion.status).toBe(403);

    const stillThere = await apiRequest(`/api/v1/spaces/${spaceId}`, owner.token);
    expect(stillThere.status).toBe(200);
  });

  it("rejects an editor demoting an owner at space level", async () => {
    const response = await postPermission(editor.token, {
      type: "role",
      roleOrFeature: "viewer",
      userId: owner.id,
      action: "grant",
    });
    expect(response.status).toBe(403);
    expect(await roleOf(owner.token)).toBe("owner");
  });

  it("rejects an editor revoking a space-level role", async () => {
    const response = await postPermission(editor.token, {
      type: "role",
      roleOrFeature: "viewer",
      userId: bystander.id,
      action: "revoke",
    });
    expect(response.status).toBe(403);
    expect(await roleOf(bystander.token)).toBe("viewer");
  });

  it("rejects an editor downgrading a space role, including their own", async () => {
    const response = await postPermission(editor.token, {
      type: "role",
      roleOrFeature: "viewer",
      userId: editor.id,
      action: "grant",
    });
    expect(response.status).toBe(403);
    expect(await roleOf(editor.token)).toBe("editor");
  });

  it("rejects editor feature operations", async () => {
    for (const action of ["grant", "deny", "revoke"]) {
      const response = await postPermission(editor.token, {
        type: "feature",
        roleOrFeature: "manage_extensions",
        userId: editor.id,
        action,
      });
      expect(response.status).toBe(403);
    }
  });

  it("rejects a feature grant disguised as a role write at feature scope", async () => {
    const response = await postPermission(editor.token, {
      type: "role",
      roleOrFeature: "viewer",
      userId: editor.id,
      action: "grant",
      resourceType: "feature",
      resourceId: "manage_extensions",
    });
    expect(response.status).toBe(403);
  });

  it("rejects an unknown resourceType", async () => {
    const response = await postPermission(owner.token, {
      type: "role",
      roleOrFeature: "viewer",
      userId: newcomer.id,
      action: "grant",
      resourceType: "not_a_scope",
      resourceId: spaceId,
    });
    expect(response.status).toBe(400);
  });

  it("rejects owner below space scope, even for an owner", async () => {
    for (const [resourceType, resourceId] of [
      ["document", documentId],
      ["document_tree", childDocumentId],
      ["category", "any-category"],
    ] as const) {
      const response = await postPermission(owner.token, {
        type: "role",
        roleOrFeature: "owner",
        userId: bystander.id,
        action: "grant",
        resourceType,
        resourceId,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "owner can only be granted on the space itself",
      });
    }

    expect(await roleOf(bystander.token)).toBe("viewer");
  });

  it("rejects owner below space scope on an access token too", async () => {
    const mint = (name: string, permission: string) =>
      apiRequest(`/api/v1/spaces/${spaceId}/access-tokens`, owner.token, {
        method: "POST",
        body: JSON.stringify({
          name,
          resourceType: "document",
          resourceId: documentId,
          permission,
        }),
      });

    expect((await mint("escalation-token-owner", "owner")).status).toBe(400);
    expect((await mint("escalation-token-editor", "editor")).status).toBe(201);
  });

  it('rejects action "deny" on a role even for an owner', async () => {
    const response = await postPermission(owner.token, {
      type: "role",
      roleOrFeature: "owner",
      userId: bystander.id,
      action: "deny",
    });
    expect(response.status).toBe(400);
    expect(await roleOf(bystander.token)).toBe("viewer");
  });
});

describe("legitimate editor delegations still work", () => {
  it("lets an owner add a member at space level", async () => {
    const response = await postPermission(owner.token, {
      type: "role",
      roleOrFeature: "viewer",
      userId: newcomer.id,
      action: "grant",
    });
    expect(response.status).toBe(200);
    expect(await roleOf(newcomer.token)).toBe("viewer");
  });

  it("lets an editor grant and revoke document-level access", async () => {
    const grant = await postPermission(editor.token, {
      type: "role",
      roleOrFeature: "editor",
      userId: bystander.id,
      action: "grant",
      resourceType: "document",
      resourceId: documentId,
    });
    expect(grant.status).toBe(200);

    const documentWrite = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
      bystander.token,
      { method: "PUT", body: JSON.stringify({ content: "# Edited by grantee" }) },
    );
    expect(documentWrite.status).toBe(200);

    const revoke = await postPermission(editor.token, {
      type: "role",
      roleOrFeature: "editor",
      userId: bystander.id,
      action: "revoke",
      resourceType: "document",
      resourceId: documentId,
    });
    expect(revoke.status).toBe(200);
  });

  it("lets an editor grant and revoke document-tree access", async () => {
    const grant = await postPermission(editor.token, {
      type: "role",
      roleOrFeature: "viewer",
      userId: bystander.id,
      action: "grant",
      resourceType: "document_tree",
      resourceId: documentId,
    });
    expect(grant.status).toBe(200);

    const childRead = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${childDocumentId}`,
      bystander.token,
    );
    expect(childRead.status).toBe(200);

    const revoke = await postPermission(editor.token, {
      type: "role",
      roleOrFeature: "viewer",
      userId: bystander.id,
      action: "revoke",
      resourceType: "document_tree",
      resourceId: documentId,
    });
    expect(revoke.status).toBe(200);
  });

  it("lets an owner grant owner, and the new owner act as one", async () => {
    const response = await postPermission(owner.token, {
      type: "role",
      roleOrFeature: "owner",
      userId: newcomer.id,
      action: "grant",
    });
    expect(response.status).toBe(200);
    expect(await roleOf(newcomer.token)).toBe("owner");

    const rename = await apiRequest(`/api/v1/spaces/${spaceId}`, newcomer.token, {
      method: "PATCH",
      body: JSON.stringify({ name: "Escalation Space Renamed" }),
    });
    expect(rename.status).toBe(200);
  });

  it("lets an owner revoke a space-level role", async () => {
    const response = await postPermission(owner.token, {
      type: "role",
      roleOrFeature: "owner",
      userId: newcomer.id,
      action: "revoke",
    });
    expect(response.status).toBe(200);

    const summary = await apiRequest(
      `/api/v1/spaces/${spaceId}/permissions/me`,
      newcomer.token,
    );
    expect(summary.status).toBe(403);
  });
});

describe("editor cannot hand out space-level access (issue #120)", () => {
  const anonymousRead = () =>
    fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/documents/${documentId}`);

  it("refuses an editor admitting a fresh user to the space", async () => {
    const response = await postPermission(editor.token, {
      type: "role",
      roleOrFeature: "viewer",
      userId: newcomer.id,
      action: "grant",
    });
    expect(response.status).toBe(403);

    const summary = await apiRequest(
      `/api/v1/spaces/${spaceId}/permissions/me`,
      newcomer.token,
    );
    expect(summary.status).toBe(403);
  });

  it("refuses an editor raising a member from viewer to editor", async () => {
    const response = await postPermission(editor.token, {
      type: "role",
      roleOrFeature: "editor",
      userId: bystander.id,
      action: "grant",
    });
    expect(response.status).toBe(403);
    expect(await roleOf(bystander.token)).toBe("viewer");
  });

  it("refuses an editor granting the public group at space level", async () => {
    const response = await postPermission(editor.token, {
      type: "role",
      roleOrFeature: "viewer",
      groupId: "public",
      action: "grant",
    });
    expect(response.status).toBe(403);

    expect((await anonymousRead()).status).toBe(404);
  });

  it("refuses an editor granting any other group at space level", async () => {
    const response = await postPermission(editor.token, {
      type: "role",
      roleOrFeature: "editor",
      groupId: "escalation-group",
      action: "grant",
    });
    expect(response.status).toBe(403);

    const spaceGroupGrants = (await allRoleEntries()).filter(
      (entry) => entry.resourceType === "space" && entry.groupId,
    );
    expect(spaceGroupGrants).toEqual([]);
  });

  it("refuses an editor sharing even a single document with a group", async () => {
    for (const resourceType of ["document", "document_tree"]) {
      const response = await postPermission(editor.token, {
        type: "role",
        roleOrFeature: "viewer",
        groupId: "escalation-group",
        action: "grant",
        resourceType,
        resourceId: documentId,
      });
      expect(response.status).toBe(403);
    }
  });

  it("still lets an editor share a single document with a user", async () => {
    const grant = await postPermission(editor.token, {
      type: "role",
      roleOrFeature: "viewer",
      userId: newcomer.id,
      action: "grant",
      resourceType: "document",
      resourceId: documentId,
    });
    expect(grant.status).toBe(200);

    const revoke = await postPermission(editor.token, {
      type: "role",
      roleOrFeature: "viewer",
      userId: newcomer.id,
      action: "revoke",
      resourceType: "document",
      resourceId: documentId,
    });
    expect(revoke.status).toBe(200);
  });

  it("lets an owner publish the space and take it back", async () => {
    const grant = await postPermission(owner.token, {
      type: "role",
      roleOrFeature: "viewer",
      groupId: "public",
      action: "grant",
    });
    expect(grant.status).toBe(200);
    expect((await anonymousRead()).status).toBe(200);

    const revoke = await postPermission(owner.token, {
      type: "role",
      roleOrFeature: "viewer",
      groupId: "public",
      action: "revoke",
    });
    expect(revoke.status).toBe(200);
    expect((await anonymousRead()).status).toBe(404);
  });
});

describe("space ownership transfer (issue #105)", () => {
  it("refuses to revoke or downgrade the sole owner", async () => {
    const revoke = await postPermission(owner.token, {
      type: "role",
      roleOrFeature: "owner",
      userId: owner.id,
      action: "revoke",
    });
    expect(revoke.status).toBe(400);
    expect(await revoke.json()).toEqual({
      error: "A space must have at least one owner",
    });

    const downgrade = await postPermission(owner.token, {
      type: "role",
      roleOrFeature: "editor",
      userId: owner.id,
      action: "grant",
    });
    expect(downgrade.status).toBe(400);
    expect(await roleOf(owner.token)).toBe("owner");
  });

  it("lets a new owner revoke the creator and removes all implicit access", async () => {
    const grant = await postPermission(owner.token, {
      type: "role",
      roleOrFeature: "owner",
      userId: newcomer.id,
      action: "grant",
    });
    expect(grant.status).toBe(200);

    const revoke = await postPermission(newcomer.token, {
      type: "role",
      roleOrFeature: "owner",
      userId: owner.id,
      action: "revoke",
    });
    expect(revoke.status).toBe(200);

    const directAccess = await apiRequest(`/api/v1/spaces/${spaceId}`, owner.token);
    expect(directAccess.status).toBe(403);

    const spaces = (await (
      await apiRequest("/api/v1/spaces", owner.token)
    ).json()) as Array<{ id: string }>;
    expect(spaces.some((space) => space.id === spaceId)).toBe(false);

    expect(await roleOf(newcomer.token)).toBe("owner");
  });
});
