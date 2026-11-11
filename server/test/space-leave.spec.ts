import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSessionApiRequest,
  createTestUser,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7573;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);
const makeUser = (name: string) => createTestUser(BASE_URL, name, "test-space-leave");

let serverProcess: TestServerProcess;
let owner: { id: string; token: string };
let member: { id: string; email: string; token: string };
let outsider: { id: string; token: string };
let spaceId: string;

async function listedSpaceIds(token: string): Promise<string[]> {
  const response = await apiRequest("/api/v1/spaces", token);
  expect(response.status).toBe(200);
  return (await response.json()).map((space: { id: string }) => space.id);
}

function leave(token: string): Promise<Response> {
  return apiRequest(`/api/v1/spaces/${spaceId}/leave`, token, { method: "POST" });
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "space-leave-test-secret",
  });
  await waitForServer(BASE_URL);

  const ownerUser = await makeUser("Leave Owner");
  owner = { id: ownerUser.userId, token: ownerUser.token };
  const memberUser = await makeUser("Leave Member");
  member = {
    id: memberUser.userId,
    email: memberUser.email,
    token: memberUser.token,
  };
  const outsiderUser = await makeUser("Leave Outsider");
  outsider = { id: outsiderUser.userId, token: outsiderUser.token };

  const spaceResponse = await apiRequest("/api/v1/spaces", owner.token, {
    method: "POST",
    body: JSON.stringify({ name: "Leave Space", slug: `leave-space-${Date.now()}` }),
  });
  if (!spaceResponse.ok) {
    throw new Error(`Failed to create space (${spaceResponse.status})`);
  }
  spaceId = (await spaceResponse.json()).space.id;

  const invite = await apiRequest(`/api/v1/spaces/${spaceId}/permissions`, owner.token, {
    method: "POST",
    body: JSON.stringify({
      type: "role",
      roleOrFeature: "viewer",
      email: member.email,
      action: "grant",
    }),
  });
  if (!invite.ok) {
    throw new Error(`Failed to invite member (${invite.status}): ${await invite.text()}`);
  }
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("leaving a space", () => {
  it("lists the space for an invited member", async () => {
    expect(await listedSpaceIds(member.token)).toContain(spaceId);
  });

  it("refuses an owner", async () => {
    expect((await leave(owner.token)).status).toBe(400);
    expect(await listedSpaceIds(owner.token)).toContain(spaceId);
  });

  it("refuses someone with no grant in the space", async () => {
    expect((await leave(outsider.token)).status).toBe(403);
  });

  it("revokes the member's grants and drops the space from their listing", async () => {
    expect((await leave(member.token)).status).toBe(200);

    expect(await listedSpaceIds(member.token)).not.toContain(spaceId);

    const read = await apiRequest(`/api/v1/spaces/${spaceId}`, member.token);
    expect([403, 404]).toContain(read.status);
  });

  it("refuses a second leave", async () => {
    expect((await leave(member.token)).status).toBe(403);
  });
});
