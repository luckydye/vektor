/**
 * Role-based access tests for /api/v1/spaces/:spaceId/workflows/schedules.
 * Read (GET) and write (POST/PATCH/DELETE) both require the "editor" space
 * role or higher; "viewer" and non-members are denied.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  createSessionApiRequest,
  createTestUser,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7487;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);
const createTestUserForSpec = (name: string) =>
  createTestUser(BASE_URL, name, "test-workflow-schedules");

let serverProcess: TestServerProcess;

let ownerToken: string;
let spaceId: string;
let workflowDocumentId: string;

let viewerToken: string;
let editorToken: string;
let nonMemberToken: string;

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "workflow-schedules-test-secret-do-not-use",
  });
  await waitForServer(BASE_URL);

  const owner = await createTestUserForSpec("Owner User");
  ownerToken = owner.token;

  const viewer = await createTestUserForSpec("Viewer User");
  viewerToken = viewer.token;

  const editor = await createTestUserForSpec("Editor User");
  editorToken = editor.token;

  const nonMember = await createTestUserForSpec("Non Member User");
  nonMemberToken = nonMember.token;

  const spaceResponse = await apiRequest("/api/v1/spaces", ownerToken, {
    method: "POST",
    body: JSON.stringify({
      name: "Workflow Schedules Test Space",
      slug: `workflow-schedules-test-${Date.now()}`,
    }),
  });
  const spaceData = await spaceResponse.json();
  spaceId = spaceData.space.id;

  const docResponse = await apiRequest(
    `/api/v1/spaces/${spaceId}/documents`,
    ownerToken,
    {
      method: "POST",
      body: JSON.stringify({
        type: "workflow",
        content:
          '{"node1":{"extensionId":"test","jobId":"noop","inputs":[],"depends":[]}}',
        properties: { title: "Schedules Test Workflow" },
      }),
    },
  );
  const docData = await docResponse.json();
  workflowDocumentId = docData.document.id;

  await apiRequest(`/api/v1/spaces/${spaceId}/permissions`, ownerToken, {
    method: "POST",
    body: JSON.stringify({
      type: "role",
      roleOrFeature: "viewer",
      userId: viewer.userId,
      action: "grant",
    }),
  });

  await apiRequest(`/api/v1/spaces/${spaceId}/permissions`, ownerToken, {
    method: "POST",
    body: JSON.stringify({
      type: "role",
      roleOrFeature: "editor",
      userId: editor.userId,
      action: "grant",
    }),
  });
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

function createScheduleBody() {
  return {
    documentId: workflowDocumentId,
    cronExpression: "0 6 * * 1",
  };
}

describe("Workflow schedules - read access (GET list)", () => {
  it("denies a non-member", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules`,
      nonMemberToken,
    );
    expect(response.status).toBe(403);
  });

  it("denies a viewer", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules`,
      viewerToken,
    );
    expect(response.status).toBe(403);
  });

  it("allows an editor", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules`,
      editorToken,
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data.schedules)).toBe(true);
  });

  it("allows the space owner", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules`,
      ownerToken,
    );
    expect(response.status).toBe(200);
  });
});

describe("Workflow schedules - create access (POST)", () => {
  it("denies a non-member", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules`,
      nonMemberToken,
      { method: "POST", body: JSON.stringify(createScheduleBody()) },
    );
    expect(response.status).toBe(403);
  });

  it("denies a viewer", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules`,
      viewerToken,
      { method: "POST", body: JSON.stringify(createScheduleBody()) },
    );
    expect(response.status).toBe(403);
  });

  it("allows an editor", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules`,
      editorToken,
      { method: "POST", body: JSON.stringify(createScheduleBody()) },
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.schedule.documentId).toBe(workflowDocumentId);
  });

  it("allows the space owner", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules`,
      ownerToken,
      { method: "POST", body: JSON.stringify(createScheduleBody()) },
    );
    expect(response.status).toBe(200);
  });
});

describe("Workflow schedules - single-schedule access (GET/PATCH/DELETE)", () => {
  let scheduleId: string;

  beforeAll(async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules`,
      ownerToken,
      { method: "POST", body: JSON.stringify(createScheduleBody()) },
    );
    const data = await response.json();
    scheduleId = data.schedule.id;
  });

  it("denies GET to a non-member", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules/${scheduleId}`,
      nonMemberToken,
    );
    expect(response.status).toBe(403);
  });

  it("denies GET to a viewer", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules/${scheduleId}`,
      viewerToken,
    );
    expect(response.status).toBe(403);
  });

  it("allows GET to an editor", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules/${scheduleId}`,
      editorToken,
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.schedule.id).toBe(scheduleId);
  });

  it("denies PATCH to a viewer", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules/${scheduleId}`,
      viewerToken,
      { method: "PATCH", body: JSON.stringify({ enabled: false }) },
    );
    expect(response.status).toBe(403);
  });

  it("allows PATCH to an editor", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules/${scheduleId}`,
      editorToken,
      { method: "PATCH", body: JSON.stringify({ enabled: false }) },
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.schedule.enabled).toBe(false);
  });

  it("denies DELETE to a viewer", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules/${scheduleId}`,
      viewerToken,
      { method: "DELETE" },
    );
    expect(response.status).toBe(403);
  });

  it("allows DELETE to an editor", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules/${scheduleId}`,
      editorToken,
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);
  });
});

describe("Workflow schedules - require a space-level role, not a narrower grant", () => {
  // These users have "editor" on a single document / category, but no
  // space-level role at all. verifySpaceRole must reject them — schedule
  // access is a space-wide capability, not something a doc/category grant
  // can substitute for.
  let docEditorToken: string;
  let categoryEditorToken: string;
  let categoryScopedDocumentId: string;

  beforeAll(async () => {
    const docEditor = await createTestUserForSpec("Doc-Only Editor");
    await apiRequest(`/api/v1/spaces/${spaceId}/permissions`, ownerToken, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "editor",
        userId: docEditor.userId,
        resourceType: "document",
        resourceId: workflowDocumentId,
        action: "grant",
      }),
    });
    docEditorToken = docEditor.token;

    const categoryResponse = await apiRequest(
      `/api/v1/spaces/${spaceId}/categories`,
      ownerToken,
      {
        method: "POST",
        body: JSON.stringify({
          name: "Schedules ACL Category",
          slug: `schedules-acl-category-${Date.now()}`,
        }),
      },
    );
    const category = (await categoryResponse.json()).category;

    const categoryDocResponse = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents`,
      ownerToken,
      {
        method: "POST",
        body: JSON.stringify({
          type: "workflow",
          content:
            '{"node1":{"extensionId":"test","jobId":"noop","inputs":[],"depends":[]}}',
          properties: { title: "Category-scoped Workflow", category: category.slug },
        }),
      },
    );
    categoryScopedDocumentId = (await categoryDocResponse.json()).document.id;

    const categoryEditor = await createTestUserForSpec("Category-Only Editor");
    await apiRequest(`/api/v1/spaces/${spaceId}/permissions`, ownerToken, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "editor",
        userId: categoryEditor.userId,
        resourceType: "category",
        resourceId: category.id,
        action: "grant",
      }),
    });
    categoryEditorToken = categoryEditor.token;
  });

  it("denies GET list to a user with only document-level editor", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules`,
      docEditorToken,
    );
    expect(response.status).toBe(403);
  });

  it("denies POST create to a user with only document-level editor, even for that document", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules`,
      docEditorToken,
      {
        method: "POST",
        body: JSON.stringify({
          documentId: workflowDocumentId,
          cronExpression: "0 6 * * 1",
        }),
      },
    );
    expect(response.status).toBe(403);
  });

  it("denies GET list to a user with only category-level editor", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules`,
      categoryEditorToken,
    );
    expect(response.status).toBe(403);
  });

  it("denies POST create to a user with only category-level editor, even for a document in that category", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/workflows/schedules`,
      categoryEditorToken,
      {
        method: "POST",
        body: JSON.stringify({
          documentId: categoryScopedDocumentId,
          cronExpression: "0 6 * * 1",
        }),
      },
    );
    expect(response.status).toBe(403);
  });
});
