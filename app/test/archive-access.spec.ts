/**
 * Archive is the product's "delete", so it must withdraw the document from
 * everyone it was shared with. It does that by requiring `editor` to read an
 * archived document rather than by deleting the grants — which is why restoring
 * one brings its shares back, and why a permanent delete still purges them.
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
let viewerToken: string;
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
async function sharePublicly(
  documentId: string,
  role = "viewer",
  resourceType = "document",
): Promise<Response> {
  return apiRequest(`/api/v1/spaces/${spaceId}/permissions`, ownerToken, {
    method: "POST",
    body: JSON.stringify({
      type: "role",
      roleOrFeature: role,
      groupId: "public",
      action: "grant",
      resourceType,
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

const readDocument = (documentId: string, token: string) =>
  apiRequest(`/api/v1/spaces/${spaceId}/documents/${documentId}`, token);

const breadcrumbs = (documentId: string, token: string) =>
  apiRequest(`/api/v1/spaces/${spaceId}/documents/${documentId}/breadcrumbs`, token);

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

/** Grant `userId` a space-wide role, as the space owner. */
async function grantSpaceRole(userId: string, role: string): Promise<void> {
  const response = await apiRequest(`/api/v1/spaces/${spaceId}/permissions`, ownerToken, {
    method: "POST",
    body: JSON.stringify({
      type: "role",
      roleOrFeature: role,
      userId,
      action: "grant",
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to grant ${role} role (${response.status})`);
  }
}

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
  const viewer = await createTestUser(BASE_URL, "Archive Viewer", "test-archive-viewer");
  viewerToken = viewer.token;

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

  // Both roles come from the space, not from any one document: archiving must
  // leave the editor alone and lock the viewer out.
  await grantSpaceRole(editor.userId, "editor");
  await grantSpaceRole(viewer.userId, "viewer");
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

    // Sanity: a later refusal is then caused by the archive, not a broken grant.
    const beforeArchive = await anonRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
    );
    expect(beforeArchive.status).toBe(200);

    const archived = await archive(documentId);
    expect(archived.status).toBe(200);

    const afterArchive = await anonRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
    );
    expect(afterArchive.status).toBe(404);
    const body = await afterArchive.text();
    expect(body).not.toContain("archive must end this");
  });

  it("keeps the public-group ACL row rather than deleting the share", async () => {
    const documentId = await createDocument("Grant Kept", "<p>grant kept</p>");
    await sharePublicly(documentId);

    await archive(documentId);

    const after = await documentGrants(documentId);
    expect(after).toHaveLength(1);
    expect(after[0]?.groupId).toBe("public");
    expect(after[0]?.permission).toBe("viewer");
  });

  it("serves the anonymous caller again once the document is restored", async () => {
    const documentId = await createDocument(
      "Restored After Archive",
      "<p>restored content</p>",
    );
    await sharePublicly(documentId);
    await archive(documentId);
    expect(
      (await anonRequest(`/api/v1/spaces/${spaceId}/documents/${documentId}`)).status,
    ).toBe(404);

    const restored = await restore(documentId);
    expect(restored.status).toBe(200);

    // The grant was never touched, only outranked while the document sat in trash.
    const anonymous = await anonRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
    );
    expect(anonymous.status).toBe(200);
    const data = await anonymous.json();
    expect(data.document.archived).toBeFalsy();
    expect(data.document.content).toContain("restored content");
  });

  it("withholds a public grant made at document_tree scope too", async () => {
    const documentId = await createDocument("Tree Shared", "<p>tree shared</p>");
    const grant = await sharePublicly(documentId, "viewer", "document_tree");
    expect(grant.status).toBe(200);

    const beforeArchive = await anonRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
    );
    expect(beforeArchive.status).toBe(200);

    await archive(documentId);

    const afterArchive = await anonRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
    );
    expect(afterArchive.status).toBe(404);
  });

  it("honours a public grant at editor level, which clears the raised bar", async () => {
    const documentId = await createDocument("Public Editor", "<p>public editor</p>");
    const grant = await sharePublicly(documentId, "editor");
    expect(grant.status).toBe(200);

    await archive(documentId);

    const response = await anonRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).document.archived).toBeTruthy();
  });
});

describe("archiving locks out space viewers", () => {
  it("lets an editor read an archived document so it can be restored", async () => {
    const documentId = await createDocument("Editor Readable", "<p>editor can read</p>");
    await sharePublicly(documentId);
    await archive(documentId);

    const response = await readDocument(documentId, editorToken);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.document.archived).toBeTruthy();
    expect(data.document.content).toContain("editor can read");

    expect((await restore(documentId, editorToken)).status).toBe(200);
  });

  it("refuses a space viewer once the document is archived", async () => {
    const documentId = await createDocument("Viewer Locked Out", "<p>viewer content</p>");

    const beforeArchive = await readDocument(documentId, viewerToken);
    expect(beforeArchive.status).toBe(200);
    expect((await beforeArchive.json()).document.content).toContain("viewer content");

    await archive(documentId);

    const afterArchive = await readDocument(documentId, viewerToken);
    expect(afterArchive.status).toBe(403);
    expect(await afterArchive.text()).not.toContain("viewer content");

    // Restoring hands it back, so this is a withdrawal and not a lost document.
    await restore(documentId);
    expect((await readDocument(documentId, viewerToken)).status).toBe(200);
  });

  it("withholds an archived document's title and path from a space viewer", async () => {
    const parentId = await createDocument("Archived Parent", "<p>parent</p>");
    const documentId = await createDocument("Archived Title Secret", "<p>child</p>");
    await apiRequest(`/api/v1/spaces/${spaceId}/documents/${documentId}`, ownerToken, {
      method: "PATCH",
      body: JSON.stringify({ parentId }),
    });

    const beforeArchive = await breadcrumbs(documentId, viewerToken);
    expect(beforeArchive.status).toBe(200);

    await archive(documentId);

    const afterArchive = await breadcrumbs(documentId, viewerToken);
    expect(afterArchive.status).toBe(403);
    // The titles are the disclosure: a viewer may see them in the space at
    // large, but the archive withdraws this document from them.
    expect(await afterArchive.text()).not.toContain("Archived Title Secret");

    expect((await breadcrumbs(documentId, editorToken)).status).toBe(200);
  });

  it("keeps the trash listing to editors", async () => {
    const documentId = await createDocument("Trash Listed", "<p>trash listed</p>");
    await archive(documentId);

    const forViewer = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents?archived=true`,
      viewerToken,
    );
    expect(forViewer.status).toBe(403);

    const forEditor = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents?archived=true`,
      editorToken,
    );
    expect(forEditor.status).toBe(200);
    const listed = (await forEditor.json()) as { documents: Array<{ id: string }> };
    expect(listed.documents.some((doc) => doc.id === documentId)).toBe(true);
  });

  it("leaves a document that was never shared unaffected", async () => {
    const documentId = await createDocument("Never Shared", "<p>never shared</p>");

    expect(
      (await anonRequest(`/api/v1/spaces/${spaceId}/documents/${documentId}`)).status,
    ).toBe(404);
    expect(await documentGrants(documentId)).toHaveLength(0);

    expect((await archive(documentId)).status).toBe(200);

    expect(
      (await anonRequest(`/api/v1/spaces/${spaceId}/documents/${documentId}`)).status,
    ).toBe(404);
    expect(await documentGrants(documentId)).toHaveLength(0);

    const owner = await readDocument(documentId, ownerToken);
    expect(owner.status).toBe(200);
    expect((await owner.json()).document.content).toContain("never shared");

    expect((await readDocument(documentId, editorToken)).status).toBe(200);
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

    // Nothing is left for whatever reuses this id to inherit.
    expect(await documentGrants(documentId)).toHaveLength(0);
    expect(
      (await anonRequest(`/api/v1/spaces/${spaceId}/documents/${documentId}`)).status,
    ).toBe(404);
  });
});
