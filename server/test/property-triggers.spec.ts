/**
 * Trigger properties: a document property of type "trigger" starts a workflow
 * once its time has come, fired by the server's scheduler tick (every 30s).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSessionApiRequest,
  createTestUser,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7572;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let ownerToken: string;
let spaceId: string;
let workflowId: string;

async function createDocument(body: Record<string, unknown>): Promise<Response> {
  return apiRequest(`/api/v1/spaces/${spaceId}/documents`, ownerToken, {
    method: "POST",
    body: JSON.stringify({ content: "", ...body }),
  });
}

async function patchProperties(
  documentId: string,
  properties: Record<string, unknown>,
): Promise<Response> {
  return apiRequest(`/api/v1/spaces/${spaceId}/documents/${documentId}`, ownerToken, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

type RunEntry = { runtimeInputs: Record<string, unknown> };

async function triggeredDocumentIds(): Promise<string[]> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/workflows/runs?filterDocumentId=${workflowId}`,
    ownerToken,
  );
  const { runs } = (await response.json()) as { runs: RunEntry[] };
  return runs.map((run) => String(run.runtimeInputs.documentId));
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "property-triggers-test-secret-do-not-use",
  });
  await waitForServer(BASE_URL);

  ownerToken = (await createTestUser(BASE_URL, "Owner User", "test-property-triggers"))
    .token;

  const spaceResponse = await apiRequest("/api/v1/spaces", ownerToken, {
    method: "POST",
    body: JSON.stringify({
      name: "Property Triggers Test Space",
      slug: `property-triggers-test-${Date.now()}`,
      preferences: { workflowCreationEnabled: "true" },
    }),
  });
  spaceId = (await spaceResponse.json()).space.id;

  const workflowResponse = await createDocument({
    type: "workflow",
    content: "const triggered = input.documentId;",
    properties: { title: "Triggered Workflow" },
  });
  workflowId = (await workflowResponse.json()).document.id;
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("Trigger properties - validation", () => {
  it("refuses a trigger in a space with workflows disabled", async () => {
    const spaceResponse = await apiRequest("/api/v1/spaces", ownerToken, {
      method: "POST",
      body: JSON.stringify({
        name: "Workflows Disabled Space",
        slug: `property-triggers-disabled-${Date.now()}`,
      }),
    });
    const disabledSpaceId = (await spaceResponse.json()).space.id;

    const response = await apiRequest(
      `/api/v1/spaces/${disabledSpaceId}/documents`,
      ownerToken,
      {
        method: "POST",
        body: JSON.stringify({
          content: "",
          properties: { reminder: { value: "", type: "trigger" } },
        }),
      },
    );
    expect(response.status).toBe(403);
  });

  it("rejects a trigger without a workflow", async () => {
    const response = await createDocument({
      properties: {
        reminder: { value: { at: new Date().toISOString() }, type: "trigger" },
      },
    });
    expect(response.status).toBe(400);
  });

  it("rejects a trigger naming a document that is not a workflow", async () => {
    const note = (await (await createDocument({})).json()).document.id;
    const response = await patchProperties(note, {
      reminder: {
        value: { at: new Date().toISOString(), workflow: note },
        type: "trigger",
      },
    });
    expect(response.status).toBe(400);
  });

  it("rejects a trigger with both at and from", async () => {
    const response = await createDocument({
      properties: {
        reminder: {
          value: { at: new Date().toISOString(), from: "eventStart", workflow: workflowId },
          type: "trigger",
        },
      },
    });
    expect(response.status).toBe(400);
  });
});

describe("Trigger properties - firing", () => {
  it("keeps property-owned schedules out of the recurring schedule API", async () => {
    const trigger = await createDocument({
      properties: {
        reminder: {
          value: { at: "2099-01-01T00:00:00Z", workflow: workflowId },
          type: "trigger",
        },
      },
    });
    expect(trigger.ok).toBe(true);
    const path = `/api/v1/spaces/${spaceId}/workflows/schedules`;
    const created = await apiRequest(path, ownerToken, {
      method: "POST",
      body: JSON.stringify({
        documentId: workflowId,
        cronExpression: "0 6 * * 1",
        enabled: false,
      }),
    });
    expect(created.ok).toBe(true);
    const { schedule } = await created.json();
    const listed = await apiRequest(path, ownerToken);
    expect((await listed.json()).schedules.map((entry: { id: string }) => entry.id))
      .toEqual([schedule.id]);
    const removed = await apiRequest(`${path}/${schedule.id}`, ownerToken, {
      method: "DELETE",
    });
    expect(removed.ok).toBe(true);
  });

  it("keeps per-document types when property names overlap", async () => {
    const trigger = await createDocument({
      properties: {
        reminder: {
          value: { at: "2099-01-01T00:00:00Z", workflow: workflowId },
          type: "trigger",
        },
      },
    });
    const triggerId = (await trigger.json()).document.id;
    const triggerRead = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${triggerId}`,
      ownerToken,
    );
    expect((await triggerRead.json()).document.propertyTypes.reminder).toBe("trigger");
    const response = await createDocument({
      properties: { reminder: { value: "Call tomorrow", type: "text" } },
    });
    const id = (await response.json()).document.id;
    const read = await apiRequest(`/api/v1/spaces/${spaceId}/documents/${id}`, ownerToken);
    const { document } = await read.json();
    expect(document.propertyTypes.reminder).toBe("text");
    expect(document.properties.reminder).toBe("Call tomorrow");
  });

  it("allows date edits after the target workflow is permanently deleted", async () => {
    const workflow = await createDocument({ type: "workflow", content: "const done = true;" });
    const targetId = (await workflow.json()).document.id;
    const response = await createDocument({
      properties: {
        eventStart: { value: "2099-01-01T00:00:00Z", type: "date" },
        reminder: {
          value: { from: "eventStart", workflow: targetId },
          type: "trigger",
        },
      },
    });
    const id = (await response.json()).document.id;
    const deleted = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${targetId}?permanent=true`,
      ownerToken,
      { method: "DELETE" },
    );
    expect(deleted.ok).toBe(true);
    const changed = await patchProperties(id, {
      eventStart: { value: "2099-02-01T00:00:00Z", type: "date" },
    });
    expect(changed.status).toBe(200);
    const read = await apiRequest(`/api/v1/spaces/${spaceId}/documents/${id}`, ownerToken);
    expect((await read.json()).document.properties.eventStart).toBe("2099-02-01T00:00:00Z");
  });

  it("fires at, follows its from date, and never fires one armed in the past", async () => {
    const soon = () => new Date(Date.now() + 2_000).toISOString();

    const fixed = await createDocument({
      properties: { reminder: { value: { at: soon(), workflow: workflowId }, type: "trigger" } },
    });
    const fixedId = (await fixed.json()).document.id;

    const past = await createDocument({
      properties: {
        reminder: {
          value: { at: new Date(Date.now() - 60_000).toISOString(), workflow: workflowId },
          type: "trigger",
        },
      },
    });
    const pastId = (await past.json()).document.id;

    const archived = await createDocument({
      properties: {
        reminder: { value: { at: soon(), workflow: workflowId }, type: "trigger" },
      },
    });
    const archivedId = (await archived.json()).document.id;
    expect((await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${archivedId}`,
      ownerToken,
      { method: "DELETE" },
    )).ok).toBe(true);

    // Armed against a date far away, then pulled in by editing that date.
    const event = await createDocument({
      properties: {
        eventStart: { value: "2099-01-01T00:00:00Z", type: "date" },
        reminder: {
          value: { from: "eventStart", offsetMinutes: -10, workflow: workflowId },
          type: "trigger",
        },
      },
    });
    const eventId = (await event.json()).document.id;
    // Keep the anchor in the future after firing, with nonzero milliseconds.
    const anchor = new Date(Math.floor(Date.now() / 1000) * 1000 + 602_123).toISOString();
    expect((await patchProperties(eventId, { eventStart: { value: anchor, type: "date" } })).status).toBe(200);

    const deadline = Date.now() + 45_000;
    let fired: string[] = [];
    while (Date.now() < deadline) {
      fired = await triggeredDocumentIds();
      if (fired.includes(fixedId) && fired.includes(eventId)) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    expect(fired).toContain(fixedId);
    expect(fired).toContain(eventId);
    expect(fired).not.toContain(pastId);
    expect(fired).not.toContain(archivedId);
    expect(fired.filter((id) => id === fixedId)).toHaveLength(1);
    expect((await patchProperties(eventId, { eventStart: { value: anchor, type: "date" } })).status).toBe(200);
    // Give another scheduler tick time to expose an incorrectly re-armed trigger.
    await new Promise((resolve) => setTimeout(resolve, 35_000));
    expect((await triggeredDocumentIds()).filter((id) => id === eventId)).toHaveLength(1);
  }, 100_000);
});
