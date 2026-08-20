/**
 * The per-user cap on space creation. Every space allocates a database of its
 * own, so an uncapped `POST /spaces` hands whoever can sign up the instance's
 * disk and file descriptors.
 */

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

const PORT = 7532;
const BASE_URL = testBaseUrl(PORT);
const LIMIT = 2;
const apiRequest = createSessionApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let user: TestUserSession;

function createSpace(session: TestUserSession, slug: string): Promise<Response> {
  return apiRequest("/api/v1/spaces", session.token, {
    method: "POST",
    body: JSON.stringify({ name: slug, slug }),
  });
}

async function createdSpaceId(session: TestUserSession, slug: string): Promise<string> {
  const response = await createSpace(session, slug);
  if (response.status !== 201) {
    throw new Error(`Failed to create ${slug}: ${response.status}`);
  }
  return (await response.json()).space.id;
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_API_ONLY: "1",
    VEKTOR_EMAIL_AUTH: "1",
    VEKTOR_MAX_SPACES_PER_USER: String(LIMIT),
    AUTH_SECRET: process.env.AUTH_SECRET ?? "space-quota-test-secret",
  });
  await waitForServer(BASE_URL);
  user = await createTestUser(BASE_URL, "Quota User", "quota");
}, 30_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("space creation quota", () => {
  it("refuses the space past the cap and says why", async () => {
    const spaceIds = [
      await createdSpaceId(user, "quota-one"),
      await createdSpaceId(user, "quota-two"),
    ];

    const refused = await createSpace(user, "quota-three");
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toContain(`limit of ${LIMIT} spaces`);

    // Reported to the client too, so the UI hides creation rather than offering
    // a button that 403s.
    const me = await apiRequest("/api/v1/users/me", user.token);
    expect((await me.json()).canCreateSpace).toBe(false);

    const deleted = await apiRequest(`/api/v1/spaces/${spaceIds[0]}`, user.token, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);

    // Deleting frees the slot: the cap counts spaces held, not ever created.
    expect((await createSpace(user, "quota-four")).status).toBe(201);
  }, 30_000);

  it("caps each user separately", async () => {
    const other = await createTestUser(BASE_URL, "Other Quota User", "quota-other");
    expect((await createSpace(other, "quota-other-one")).status).toBe(201);
  }, 30_000);
});
