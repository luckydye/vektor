/**
 * Archiving a document must revoke the shares that point at it.
 *
 * Archive is the product's "delete": it hides the document from every list and
 * from search, including the owner's own. If the document's ACL grants survive
 * that, a publicly shared document stays readable by anyone holding the link
 * while its owner can no longer find it to unshare it — deleting makes the
 * exposure permanent instead of ending it.
 *
 * The rule these specs pin down:
 *   - a public-group grant on a document is honoured while it is live;
 *   - archiving revokes it, so anonymous reads stop;
 *   - restoring does NOT reinstate it (re-sharing is an explicit action);
 *   - access that comes from the space still works, so an editor can read an
 *     archived document in order to restore it;
 *   - a document that was never shared is unaffected either way.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createApiRequest,
  createSessionApiRequest,
  createTestUser,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7497;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);
const anonRequest = createApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let ownerToken: string;
let editorToken: string;
let spaceId: string;

async function createDocument(title: string, content: string): Promise<string> {
  const response = await apiRequest(`/api/v1/spaces/${spaceId}/documents`, ownerToken, {
    method: "POST",
    body: JSON.stringify({ content, properties: { title } }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create document (${response.status})`);
  }
  const data = await response.json();
  return data.document.id;
}

/** Share a document with the public group at `role`, as the space owner. */
async function sharePublicly(documentId: string, role = "viewer"): Promise<Response> {
  return apiRequest(`/api/v1/spaces/${spaceId}/permissions`, ownerToken, {
    method: "POST",
    body: JSON.stringify({
      type: "role",
      roleOrFeature: role,
      groupId: "public",
      action: "grant",
      resourceType: "document",
      resourceId: documentId,
    }),
  });
}

interface Grant {
  resourceType: string;
  resourceId: string;
  userId?: string | null;
  groupId?: string | null;
  permission: string;
}

/** The document-scoped ACL rows the owner can see for `documentId`. */
async function documentGrants(documentId: string): Promise<Grant[]> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/permissions?type=role&resourceType=document&resourceId=${documentId}`,
    ownerToken,
  );
  expect(response.status).toBe(200);
  const data = (await response.json()) as { permissions: Array<{ permission: Grant }> };
  return data.permissions.map((p) => p.permission);
}

const archive = (documentId: string, token = ownerToken) =>
  apiRequest(`/api/v1/spaces/${spaceId}/documents/${documentId}`, token, {
    method: "DELETE",
  });

/** Restore lives on PUT (see `ApiClient.document.restore`), not on PATCH. */
const restore = (documentId: string, token = ownerToken) =>
  apiRequest(`/api/v1/spaces/${spaceId}/documents/${documentId}`, token, {
    method: "PUT",
    body: JSON.stringify({ restore: true }),
  });

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET:
      process.env.AUTH_SECRET ?? "archive-test-secret-do-not-use-in-production",
  });
  await waitForServer(BASE_URL);

  const owner = await createTestUser(BASE_URL, "Archive Owner", "test-archive-owner");
  ownerToken = owner.token;
  const editor = await createTestUser(BASE_URL, "Archive Editor", "test-archive-editor");
  editorToken = editor.token;

  const spaceResponse = await apiRequest("/api/v1/spaces", ownerToken, {
    method: "POST",
    body: JSON.stringify({
      name: "Archive Access Space",
      slug: `archive-access-${Date.now()}`,
    }),
  });
  if (!spaceResponse.ok) {
    throw new Error(`Failed to create space (${spaceResponse.status})`);
  }
  spaceId = (await spaceResponse.json()).space.id;

  // The editor's access comes from the space, not from the document — that is
  // exactly the access archiving must leave alone.
  const grantEditor = await apiRequest(
    `/api/v1/spaces/${spaceId}/permissions`,
    ownerToken,
    {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "editor",
        userId: editor.userId,
        action: "grant",
      }),
    },
  );
  if (!grantEditor.ok) {
    throw new Error(`Failed to grant editor role (${grantEditor.status})`);
  }
});

afterAll(() => {
  serverProcess?.kill();
});

describe("archiving a publicly shared document", () => {
  it("serves the document to an anonymous caller while it is shared", async () => {
    const documentId = await createDocument(
      "Publicly Shared",
      "<p>PUBLIC then ARCHIVED secret</p>",
    );

    const grant = await sharePublicly(documentId);
    expect(grant.status).toBe(200);

    const response = await anonRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.document.content).toContain("PUBLIC then ARCHIVED secret");
    expect(data.document.archived).toBeFalsy();
  });

  it("refuses the anonymous caller once the document is archived", async () => {
    const documentId = await createDocument(
      "Archived While Shared",
      "<p>archive must end this</p>",
    );
    await sharePublicly(documentId);

    // Sanity: the share works before the archive, so a later refusal is caused
    // by the archive and not by a broken grant.
    const beforeArchive = await anonRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
    );
    expect(beforeArchive.status).toBe(200);

    const archived = await archive(documentId);
    expect(archived.status).toBe(200);

    const afterArchive = await anonRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
    );
    expect(afterArchive.status).toBe(401);
    const body = await afterArchive.text();
    expect(body).not.toContain("archive must end this");
  });

  it("drops the public-group ACL row rather than only hiding the document", async () => {
    const documentId = await createDocument("Grant Removed", "<p>grant removed</p>");
    await sharePublicly(documentId);

    const before = await documentGrants(documentId);
    expect(before.some((p) => p.groupId === "public")).toBe(true);

    await archive(documentId);

    const after = await documentGrants(documentId);
    expect(after.some((p) => p.groupId === "public")).toBe(false);
    expect(after).toHaveLength(0);
  });

  it("does not reinstate the public grant when the document is restored", async () => {
    const documentId = await createDocument(
      "Restored After Archive",
      "<p>restored content</p>",
    );
    await sharePublicly(documentId);
    await archive(documentId);

    const restored = await restore(documentId);
    expect(restored.status).toBe(200);

    // Restore brings the document back for the space, not for the world:
    // re-sharing is left to the user.
    const anonymous = await anonRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
    );
    expect(anonymous.status).toBe(401);
    expect(await documentGrants(documentId)).toHaveLength(0);

    // ...and the owner still has the document, unarchived.
    const owner = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
      ownerToken,
    );
    expect(owner.status).toBe(200);
    const data = await owner.json();
    expect(data.document.archived).toBeFalsy();
    expect(data.document.content).toContain("restored content");
  });

  it("revokes a public grant that was made at document_tree scope too", async () => {
    const documentId = await createDocument("Tree Shared", "<p>tree shared</p>");
    const grant = await apiRequest(`/api/v1/spaces/${spaceId}/permissions`, ownerToken, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        groupId: "public",
        action: "grant",
        resourceType: "document_tree",
        resourceId: documentId,
      }),
    });
    expect(grant.status).toBe(200);

    const beforeArchive = await anonRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
    );
    expect(beforeArchive.status).toBe(200);

    await archive(documentId);

    const afterArchive = await anonRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
    );
    expect(afterArchive.status).toBe(401);
  });
});

describe("archiving leaves space-derived access alone", () => {
  it("lets an editor read an archived document so it can be restored", async () => {
    const documentId = await createDocument("Editor Readable", "<p>editor can read</p>");
    await sharePublicly(documentId);
    await archive(documentId);

    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
      editorToken,
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.document.archived).toBeTruthy();
    expect(data.document.content).toContain("editor can read");

    // And the editor can act on what they can read.
    expect((await restore(documentId, editorToken)).status).toBe(200);
  });

  it("leaves a document that was never shared unaffected", async () => {
    const documentId = await createDocument("Never Shared", "<p>never shared</p>");

    expect(
      (await anonRequest(`/api/v1/spaces/${spaceId}/documents/${documentId}`)).status,
    ).toBe(401);
    expect(await documentGrants(documentId)).toHaveLength(0);

    expect((await archive(documentId)).status).toBe(200);

    // Nothing to revoke, nothing broken: the owner and the editor still read it,
    // anonymous callers still cannot.
    expect(
      (await anonRequest(`/api/v1/spaces/${spaceId}/documents/${documentId}`)).status,
    ).toBe(401);
    expect(await documentGrants(documentId)).toHaveLength(0);

    const owner = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
      ownerToken,
    );
    expect(owner.status).toBe(200);
    expect((await owner.json()).document.content).toContain("never shared");

    const editor = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
      editorToken,
    );
    expect(editor.status).toBe(200);
  });
});

describe("permanently deleting a document", () => {
  it("purges the document's ACL rows", async () => {
    const documentId = await createDocument("Purged", "<p>purged</p>");
    await sharePublicly(documentId);
    expect(await documentGrants(documentId)).toHaveLength(1);

    const deleted = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}?permanent=true`,
      ownerToken,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);

    // Nothing is left to be inherited by whatever reuses this id, and the
    // public link is dead rather than pointing at an orphaned grant.
    expect(await documentGrants(documentId)).toHaveLength(0);
    expect(
      (await anonRequest(`/api/v1/spaces/${spaceId}/documents/${documentId}`)).status,
    ).toBe(404);
  });
});
