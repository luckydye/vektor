/**
 * An attachment is part of the document it was uploaded to, so the document —
 * not a space-wide role — decides who may read it. The two audiences a bare
 * space check gets wrong: an anonymous reader of a publicly shared document,
 * and a document/tree/category grantee holding no space role.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobToken } from "#jobs/jobToken.ts";
import {
  createApiRequest,
  createSessionApiRequest,
  createTestUser,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

// Shared with the spawned server below, so a token minted here verifies there.
process.env.AUTH_SECRET ??= "attachment-test-secret-do-not-use-in-production";

const PORT = 7523;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);
const anonRequest = createApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let ownerToken: string;
let spaceViewerToken: string;
let scopedToken: string;
let scopedUserId: string;
let outsiderToken: string;
let spaceId: string;

async function createDocument(title: string): Promise<string> {
  const response = await apiRequest(`/api/v1/spaces/${spaceId}/documents`, ownerToken, {
    method: "POST",
    body: JSON.stringify({ content: `<p>${title}</p>`, properties: { title } }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create document (${response.status})`);
  }
  return (await response.json()).document.id;
}

async function upload(
  token: string | null,
  content: string,
  filename: string,
  documentId?: string,
): Promise<Response> {
  const form = new FormData();
  form.set("file", new File([content], filename, { type: "text/plain" }));
  form.set("filename", filename);
  if (documentId) form.set("documentId", documentId);

  return fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/uploads`, {
    method: "POST",
    // FormData sets its own multipart Content-Type, so this bypasses the JSON helpers.
    headers: token ? { Cookie: `vektor.session_token=${token}` } : {},
    body: form,
  });
}

/** Upload as the owner and return the stored file's URL. */
async function ownerUpload(content: string, documentId?: string): Promise<string> {
  const response = await upload(ownerToken, content, "note.txt", documentId);
  if (!response.ok) {
    throw new Error(`Failed to upload (${response.status})`);
  }
  return (await response.json()).url as string;
}

const grant = (body: Record<string, unknown>): Promise<Response> =>
  apiRequest(`/api/v1/spaces/${spaceId}/permissions`, ownerToken, {
    method: "POST",
    body: JSON.stringify({ type: "role", action: "grant", ...body }),
  });

async function grantSpaceRole(userId: string, role: string): Promise<void> {
  const response = await grant({ roleOrFeature: role, userId });
  if (!response.ok) {
    throw new Error(`Failed to grant space ${role} (${response.status})`);
  }
}

async function grantOnDocument(
  documentId: string,
  role: string,
  grantee: { userId?: string; groupId?: string },
  resourceType = "document",
): Promise<void> {
  const response = await grant({
    roleOrFeature: role,
    resourceType,
    resourceId: documentId,
    ...grantee,
  });
  if (!response.ok) {
    throw new Error(`Failed to grant ${resourceType} ${role} (${response.status})`);
  }
}

const listUploads = async (token?: string): Promise<string[]> => {
  const response = token
    ? await apiRequest(`/api/v1/spaces/${spaceId}/uploads`, token)
    : await anonRequest(`/api/v1/spaces/${spaceId}/uploads`);
  expect(response.status).toBe(200);
  const data = (await response.json()) as { files: { url: string }[] };
  return data.files.map((f) => f.url);
};

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET: process.env.AUTH_SECRET,
  });
  await waitForServer(BASE_URL);

  const owner = await createTestUser(BASE_URL, "Attachment Owner", "test-att-owner");
  ownerToken = owner.token;
  const spaceViewer = await createTestUser(BASE_URL, "Space Viewer", "test-att-viewer");
  spaceViewerToken = spaceViewer.token;
  const scoped = await createTestUser(BASE_URL, "Scoped Editor", "test-att-scoped");
  scopedToken = scoped.token;
  scopedUserId = scoped.userId;
  const outsider = await createTestUser(BASE_URL, "Outsider", "test-att-outsider");
  outsiderToken = outsider.token;

  const spaceResponse = await apiRequest("/api/v1/spaces", ownerToken, {
    method: "POST",
    body: JSON.stringify({
      name: "Attachment Access Space",
      slug: `attachment-access-${Date.now()}`,
    }),
  });
  if (!spaceResponse.ok) {
    throw new Error(`Failed to create space (${spaceResponse.status})`);
  }
  spaceId = (await spaceResponse.json()).space.id;

  await grantSpaceRole(spaceViewer.userId, "viewer");
});

afterAll(() => {
  serverProcess?.kill();
});

describe("attachments of a publicly shared document", () => {
  it("serves the file to an anonymous reader of the document", async () => {
    const documentId = await createDocument("Public Media");
    const url = await ownerUpload("PUBLIC ATTACHMENT", documentId);
    await grantOnDocument(documentId, "viewer", { groupId: "public" });

    const response = await fetch(`${BASE_URL}${url}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("PUBLIC ATTACHMENT");
  });

  it("follows a public grant made at document_tree scope", async () => {
    const documentId = await createDocument("Public Tree Media");
    const url = await ownerUpload("TREE ATTACHMENT", documentId);
    await grantOnDocument(documentId, "viewer", { groupId: "public" }, "document_tree");

    const response = await fetch(`${BASE_URL}${url}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("TREE ATTACHMENT");
  });

  it("refuses an attachment of a document that is not shared", async () => {
    const documentId = await createDocument("Private Media");
    const url = await ownerUpload("PRIVATE ATTACHMENT", documentId);

    const response = await fetch(`${BASE_URL}${url}`);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("PRIVATE ATTACHMENT");
  });

  it("withdraws the attachment when the shared document is archived", async () => {
    const documentId = await createDocument("Archived Media");
    const url = await ownerUpload("ARCHIVED ATTACHMENT", documentId);
    await grantOnDocument(documentId, "viewer", { groupId: "public" });
    expect((await fetch(`${BASE_URL}${url}`)).status).toBe(200);

    const archived = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
      ownerToken,
      { method: "DELETE" },
    );
    expect(archived.status).toBe(200);

    // Archive raises the bar to `editor` for the attachment as for the document.
    expect((await fetch(`${BASE_URL}${url}`)).status).toBe(401);
    const asSpaceViewer = await apiRequest(url, spaceViewerToken);
    expect(asSpaceViewer.status).toBe(403);
  });
});

describe("attachments for a document-scoped grantee", () => {
  it("serves and lists an attachment of the document they were granted", async () => {
    const documentId = await createDocument("Shared With Carol");
    const url = await ownerUpload("SCOPED ATTACHMENT", documentId);
    await grantOnDocument(documentId, "editor", { userId: scopedUserId });

    const served = await apiRequest(url, scopedToken);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("SCOPED ATTACHMENT");

    expect(await listUploads(scopedToken)).toContain(url);
  });

  it("accepts an upload attached to that document", async () => {
    const documentId = await createDocument("Carol Uploads Here");
    await grantOnDocument(documentId, "editor", { userId: scopedUserId });

    const response = await upload(scopedToken, "CAROL UPLOAD", "carol.txt", documentId);
    expect(response.status).toBe(200);

    const url = (await response.json()).url as string;
    const served = await apiRequest(url, scopedToken);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("CAROL UPLOAD");
  });

  it("accepts that upload through a job token too", async () => {
    const documentId = await createDocument("Carol's Agent Uploads Here");
    await grantOnDocument(documentId, "editor", { userId: scopedUserId });

    const form = new FormData();
    form.set("file", new File(["AGENT UPLOAD"], "agent.txt", { type: "text/plain" }));
    form.set("filename", "agent.txt");
    form.set("documentId", documentId);
    const response = await fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/uploads`, {
      method: "POST",
      headers: {
        "X-Job-Token": createJobToken(spaceId, String(Date.now()), scopedUserId),
      },
      body: form,
    });
    expect(response.status).toBe(200);

    const url = (await response.json()).url as string;
    const served = await apiRequest(url, scopedToken);
    expect(await served.text()).toBe("AGENT UPLOAD");
  });

  it("refuses an upload with no document, which belongs to the space", async () => {
    const response = await upload(scopedToken, "SPACE WIDE", "loose.txt");
    expect(response.status).toBe(403);
  });

  it("refuses an attachment of a document they were not granted", async () => {
    const documentId = await createDocument("Not Carol's");
    const url = await ownerUpload("OFF LIMITS", documentId);

    const response = await apiRequest(url, scopedToken);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("OFF LIMITS");

    expect(await listUploads(scopedToken)).not.toContain(url);
  });

  it("refuses everything to a user with no grant in the space", async () => {
    const documentId = await createDocument("Outsider Test");
    const url = await ownerUpload("OUTSIDER DENIED", documentId);

    const served = await apiRequest(url, outsiderToken);
    expect([401, 403]).toContain(served.status);
    expect(await served.text()).not.toContain("OUTSIDER DENIED");

    // Whatever was shared with `public`, and nothing else — this file included.
    expect(await listUploads(outsiderToken)).not.toContain(url);

    const posted = await upload(outsiderToken, "OUTSIDER UPLOAD", "nope.txt", documentId);
    expect([401, 403]).toContain(posted.status);
  });
});

describe("space-wide uploads", () => {
  it("keeps serving a file that belongs to no document to space members", async () => {
    const url = await ownerUpload("LOOSE UPLOAD");

    const asViewer = await apiRequest(url, spaceViewerToken);
    expect(asViewer.status).toBe(200);
    expect(await asViewer.text()).toBe("LOOSE UPLOAD");

    expect(await listUploads(spaceViewerToken)).toContain(url);
    // A grantee reaches the space through one document, not this file.
    expect(await listUploads(scopedToken)).not.toContain(url);
  });
});
