import { beforeAll, describe, expect, it } from "bun:test";
import { createJobToken } from "../src/jobs/jobToken.ts";

const BASE_URL = process.env.VEKTOR_TEST_URL ?? "http://127.0.0.1:4321";

let sessionToken: string;
let testSpaceId: string;
let testDocumentId: string;

async function createTestUser() {
  const response = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `test-jobtoken-${Date.now()}-${Math.random()}@example.com`,
      password: "TestPassword123!",
      name: "Job Token Tester",
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create test user: ${response.statusText}`);
  }
  const data = await response.json();
  const cookies = response.headers.get("set-cookie");
  const match = cookies?.match(/better-auth\.session_token=([^;]+)/);
  return match
    ? match[1]!
    : `${data.token}.${Buffer.from(data.token).toString("base64")}`;
}

async function sessionRequest(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("Cookie", `better-auth.session_token=${sessionToken}`);
  headers.set("Content-Type", "application/json");
  return fetch(`${BASE_URL}${path}`, { ...options, headers });
}

function jobRequest(
  path: string,
  token: string,
  options: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("X-Job-Token", token);
  headers.set("Content-Type", "application/json");
  return fetch(`${BASE_URL}${path}`, { ...options, headers });
}

beforeAll(async () => {
  sessionToken = await createTestUser();
  const spaceResponse = await sessionRequest("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({ name: "Job Token Space", slug: `job-token-${Date.now()}` }),
  });
  expect(spaceResponse.status).toBe(201);
  testSpaceId = (await spaceResponse.json()).space.id;

  const docResponse = await sessionRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
    method: "POST",
    body: JSON.stringify({ content: "<p>secret</p>", properties: { title: "Secret" } }),
  });
  expect(docResponse.status).toBe(201);
  testDocumentId = (await docResponse.json()).document.id;
});

describe("X-Job-Token validation on document routes", () => {
  const docPath = () => `/api/v1/spaces/${testSpaceId}/documents/${testDocumentId}`;

  it("rejects document GET with a forged job token", async () => {
    const response = await jobRequest(docPath(), "forged-token");
    expect(response.status).toBe(401);
  });

  it("rejects document PUT with a forged job token", async () => {
    const response = await jobRequest(docPath(), "forged.token.value", {
      method: "PUT",
      body: JSON.stringify({ content: "<p>overwritten</p>" }),
    });
    expect(response.status).toBe(401);

    // Content must be unchanged.
    const read = await sessionRequest(docPath());
    expect((await read.json()).document.content).toBe("<p>secret</p>");
  });

  it("rejects a job token signed for a different space", async () => {
    const otherSpaceToken = createJobToken("space_other", String(Date.now()));
    const response = await jobRequest(docPath(), otherSpaceToken);
    expect(response.status).toBe(401);
  });

  it("accepts a valid job token for GET and PUT", async () => {
    const token = createJobToken(testSpaceId, String(Date.now()));

    const read = await jobRequest(docPath(), token);
    expect(read.status).toBe(200);
    expect((await read.json()).document.content).toBe("<p>secret</p>");

    const write = await jobRequest(docPath(), token, {
      method: "PUT",
      body: JSON.stringify({ content: "<p>updated by job</p>" }),
    });
    expect(write.status).toBe(200);
    expect((await (await jobRequest(docPath(), token)).json()).document.content).toBe(
      "<p>updated by job</p>",
    );
  });

  it("rejects the edit endpoint with a forged job token", async () => {
    const response = await jobRequest(`${docPath()}/edit`, "forged-token", {
      method: "POST",
      body: JSON.stringify({ operations: [{ op: "delete", range: "1" }] }),
    });
    expect([401, 403]).toContain(response.status);
  });
});
