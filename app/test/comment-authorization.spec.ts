import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSessionApiRequest,
  createTestUser,
  startTestServer,
  type TestServerProcess,
  type TestUserSession,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7522;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let owner: TestUserSession;
let editor: TestUserSession;
let commenter: TestUserSession;
/** Holds a document-scoped grant only — no role on the space. */
let scopedEditor: TestUserSession;
let spaceId: string;
let documentId: string;
let scopedDocumentId: string;

async function setRole(userId: string, role: "viewer" | "editor"): Promise<void> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/permissions`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: role,
        action: "grant",
        userId,
      }),
    },
  );
  expect(response.status).toBe(200);
}

async function setCommentFeature(action: "grant" | "revoke"): Promise<void> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/permissions`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        type: "feature",
        roleOrFeature: "comment",
        action,
        userId: commenter.userId,
      }),
    },
  );
  expect(response.status).toBe(200);
}

/** Grant `userId` a role on one document tree, without any space-wide role. */
async function grantDocumentTreeRole(
  userId: string,
  docId: string,
  role: "viewer" | "editor",
): Promise<void> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/permissions`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: role,
        action: "grant",
        userId,
        resourceType: "document_tree",
        resourceId: docId,
      }),
    },
  );
  expect(response.status).toBe(200);
}

async function postComment(
  sessionToken: string,
  docId: string,
  content: string,
  reference: string,
): Promise<Response> {
  return apiRequest(`/api/v1/spaces/${spaceId}/comments`, sessionToken, {
    method: "POST",
    body: JSON.stringify({ documentId: docId, content, reference }),
  });
}

async function deleteComment(
  sessionToken: string,
  docId: string,
  commentId: string,
): Promise<Response> {
  return apiRequest(`/api/v1/spaces/${spaceId}/comments`, sessionToken, {
    method: "DELETE",
    body: JSON.stringify({ documentId: docId, commentId }),
  });
}

async function createComment(
  sessionToken: string,
  content: string,
  reference: string,
): Promise<string> {
  const response = await postComment(sessionToken, documentId, content, reference);
  expect(response.status).toBe(200);
  return (await response.json()).comment.id;
}

async function patchComments(
  sessionToken: string,
  commentIds: string[],
  reference: string,
): Promise<Response> {
  return apiRequest(`/api/v1/spaces/${spaceId}/comments`, sessionToken, {
    method: "PATCH",
    body: JSON.stringify({ documentId, commentIds, reference }),
  });
}

async function comments(
  docId: string = documentId,
): Promise<Array<{ id: string; reference: string }>> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/comments?documentId=${docId}`,
    owner.token,
  );
  expect(response.status).toBe(200);
  return (await response.json()).comments;
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "comment-authorization-test-secret",
  });
  await waitForServer(BASE_URL);

  owner = await createTestUser(BASE_URL, "Comment Owner", "test-comment-auth");
  editor = await createTestUser(BASE_URL, "Comment Editor", "test-comment-auth");
  commenter = await createTestUser(
    BASE_URL,
    "Comment Viewer",
    "test-comment-auth",
  );
  scopedEditor = await createTestUser(
    BASE_URL,
    "Comment Scoped Editor",
    "test-comment-auth",
  );

  const spaceResponse = await apiRequest("/api/v1/spaces", owner.token, {
    method: "POST",
    body: JSON.stringify({
      name: "Comment Authorization",
      slug: `comment-authorization-${Date.now()}`,
    }),
  });
  expect(spaceResponse.status).toBe(201);
  spaceId = (await spaceResponse.json()).space.id;

  await setRole(editor.userId, "editor");
  await setRole(commenter.userId, "viewer");
  await setCommentFeature("grant");

  const documentResponse = await apiRequest(
    `/api/v1/spaces/${spaceId}/documents`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        content: "# Comment authorization",
        properties: { title: "Comment authorization" },
      }),
    },
  );
  expect(documentResponse.status).toBe(201);
  documentId = (await documentResponse.json()).document.id;

  const scopedDocumentResponse = await apiRequest(
    `/api/v1/spaces/${spaceId}/documents`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        content: "# Shared with an external collaborator",
        properties: { title: "Scoped document" },
      }),
    },
  );
  expect(scopedDocumentResponse.status).toBe(201);
  scopedDocumentId = (await scopedDocumentResponse.json()).document.id;
  await grantDocumentTreeRole(scopedEditor.userId, scopedDocumentId, "editor");
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("comment write authorization", () => {
  it("protects foreign comments while retaining editor moderation", async () => {
    const ownerCommentId = await createComment(owner.token, "Owner comment", "100");
    const commenterCommentId = await createComment(
      commenter.token,
      "Viewer comment",
      "200",
    );

    const unauthorized = await patchComments(
      commenter.token,
      [commenterCommentId, ownerCommentId],
      "300",
    );
    expect(unauthorized.status).toBe(403);
    expect(await comments()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ownerCommentId, reference: "100" }),
        expect.objectContaining({ id: commenterCommentId, reference: "200" }),
      ]),
    );

    const moderated = await patchComments(editor.token, [ownerCommentId], "400");
    expect(moderated.status).toBe(200);
    expect(await comments()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ownerCommentId, reference: "400" }),
      ]),
    );

    await setCommentFeature("revoke");
    const deleteWithoutFeature = await apiRequest(
      `/api/v1/spaces/${spaceId}/comments`,
      commenter.token,
      {
        method: "DELETE",
        body: JSON.stringify({ documentId, commentId: commenterCommentId }),
      },
    );
    expect(deleteWithoutFeature.status).toBe(403);
    expect((await comments()).some((comment) => comment.id === commenterCommentId)).toBe(
      true,
    );
  });
});

describe("document-scoped editor (issue #151)", () => {
  it("may comment on and moderate a document granted below space level", async () => {
    const created = await postComment(
      scopedEditor.token,
      scopedDocumentId,
      "Scoped editor comment",
      "500",
    );
    expect(created.status).toBe(200);
    const commentId = (await created.json()).comment.id;

    const patched = await apiRequest(
      `/api/v1/spaces/${spaceId}/comments`,
      scopedEditor.token,
      {
        method: "PATCH",
        body: JSON.stringify({
          documentId: scopedDocumentId,
          commentIds: [commentId],
          reference: "600",
        }),
      },
    );
    expect(patched.status).toBe(200);
    expect(await comments(scopedDocumentId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: commentId, reference: "600" })]),
    );

    const deleted = await deleteComment(scopedEditor.token, scopedDocumentId, commentId);
    expect(deleted.status).toBe(200);
    expect(
      (await comments(scopedDocumentId)).some((comment) => comment.id === commentId),
    ).toBe(false);
  });
});

describe("comment/document binding (issue #139)", () => {
  it("refuses to delete a comment through an unrelated document", async () => {
    const created = await postComment(
      owner.token,
      scopedDocumentId,
      "Owner comment on the scoped document",
      "700",
    );
    expect(created.status).toBe(200);
    const commentId = (await created.json()).comment.id;

    // `documentId` is a document the caller may comment on, but not the one the
    // comment hangs off — the authorized resource and the acted-on one differ.
    const deleted = await deleteComment(owner.token, documentId, commentId);
    expect(deleted.status).toBe(404);
    expect(
      (await comments(scopedDocumentId)).some((comment) => comment.id === commentId),
    ).toBe(true);
  });
});
