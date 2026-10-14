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

    // Armed against a date far away, then pulled in by editing that date.
    const event = await createDocument({
      properties: {
        eventStart: { value: "2099-01-01T00:00:00Z", type: "date" },
        reminder: {
          value: { from: "eventStart", offsetMinutes: 0, workflow: workflowId },
          type: "trigger",
        },
      },
    });
    const eventId = (await event.json()).document.id;
    expect((await patchProperties(eventId, { eventStart: { value: soon(), type: "date" } })).status).toBe(200);

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
    expect(fired.filter((id) => id === fixedId)).toHaveLength(1);
  }, 60_000);
});
