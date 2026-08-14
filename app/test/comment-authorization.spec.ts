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
let spaceId: string;
let documentId: string;

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

async function createComment(
  sessionToken: string,
  content: string,
  reference: string,
): Promise<string> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/comments`,
    sessionToken,
    {
      method: "POST",
      body: JSON.stringify({ documentId, content, reference }),
    },
  );
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

async function comments(): Promise<Array<{ id: string; reference: string }>> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/comments?documentId=${documentId}`,
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
