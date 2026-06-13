import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createJobToken } from "../src/jobs/jobToken.ts";

const PORT = 7481;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let serverProcess: ReturnType<typeof Bun.spawn>;
let testSpaceId: string;
let testDocumentId: string;

async function waitForServer(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/v1/spaces`);
      if (res.status < 500) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(100);
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

async function apiRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
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
  serverProcess = Bun.spawn(["bun", "./src/server.ts", "--port", String(PORT)], {
    env: {
      ...process.env,
      VEKTOR_NO_AUTH: "1",
      VEKTOR_IN_MEMORY_DB: "1",
      VEKTOR_API_ONLY: "1",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      WIKI_OTEL_ENABLED: "0",
    },
    stdout: "ignore",
    stderr: "ignore",
    cwd: import.meta.dir + "/..",
  });

  await waitForServer();

  const spaceResponse = await apiRequest("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({ name: "Job Token Space", slug: "job-token" }),
  });
  expect(spaceResponse.status).toBe(201);
  testSpaceId = (await spaceResponse.json()).space.id;

  const docResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
    method: "POST",
    body: JSON.stringify({ content: "<p>secret</p>", properties: { title: "Secret" } }),
  });
  expect(docResponse.status).toBe(201);
  testDocumentId = (await docResponse.json()).document.id;
});

afterAll(() => {
  serverProcess?.kill();
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
    const read = await apiRequest(docPath());
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
