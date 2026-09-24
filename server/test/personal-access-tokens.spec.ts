/**
 * Personal access tokens: `/api/v1/access-tokens`, the endpoint behind the
 * preferences tab and the equivalent of what `vektor login` mints.
 *
 * The interesting claims are that a plain member can mint one at all (the
 * space-wide endpoint is owner-only), that it carries exactly the issuer's own
 * role, and that one caller's tokens are invisible and untouchable to another.
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

const PORT = 7526;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let owner: TestUserSession;
let member: TestUserSession;
let outsider: TestUserSession;
let spaceId: string;

function createPersonalToken(
  session: TestUserSession,
  body: { name: string; spaceId: string; expiresInDays?: number },
): Promise<Response> {
  return apiRequest("/api/v1/access-tokens", session.token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function listPersonalTokens(session: TestUserSession) {
  const response = await apiRequest("/api/v1/access-tokens", session.token);
  expect(response.status).toBe(200);
  return (await response.json()).tokens as Array<{
    id: string;
    name: string;
    spaceId: string;
    spaceName: string;
    revokedAt: string | null;
    resources: Array<{ permission: string; resourceType: string }>;
  }>;
}

function listDocumentsWithToken(token: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/documents?limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function writeDocumentWithToken(token: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/documents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: "# written by a personal token" }),
  });
}

async function setMemberRole(role: string, action: "grant" | "revoke") {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/permissions`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: role,
        action,
        userId: member.userId,
      }),
    },
  );
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "personal-access-tokens-test-secret",
  });
  await waitForServer(BASE_URL);

  owner = await createTestUser(BASE_URL, "Token Owner", "test-personal-tokens");
  member = await createTestUser(BASE_URL, "Token Member", "test-personal-tokens");
  outsider = await createTestUser(BASE_URL, "Token Outsider", "test-personal-tokens");

  const spaceResponse = await apiRequest("/api/v1/spaces", owner.token, {
    method: "POST",
    body: JSON.stringify({
      name: "Personal Tokens",
      slug: `personal-tokens-${Date.now()}`,
    }),
  });
  expect(spaceResponse.status).toBe(201);
  spaceId = (await spaceResponse.json()).space.id;

  await setMemberRole("editor", "grant");
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("personal access tokens", () => {
  it("mints a token carrying the member's own role, with no owner rights needed", async () => {
    const response = await createPersonalToken(member, {
      name: "Member CLI",
      spaceId,
      expiresInDays: 30,
    });
    expect(response.status).toBe(201);

    const created = await response.json();
    expect(created.permission).toBe("editor");
    expect(created.token).toMatch(/^at_/);

    // The same member may not use the space-wide endpoint, which is the whole
    // reason this one exists.
    const spaceEndpoint = await apiRequest(
      `/api/v1/spaces/${spaceId}/access-tokens`,
      member.token,
      {
        method: "POST",
        body: JSON.stringify({
          name: "via space endpoint",
          resourceType: "space",
          resourceId: spaceId,
          permission: "editor",
        }),
      },
    );
    expect(spaceEndpoint.status).toBe(403);

    expect((await listDocumentsWithToken(created.token)).status).toBe(200);
    expect((await writeDocumentWithToken(created.token)).status).toBe(201);
  });

  it("lists only the caller's own tokens", async () => {
    expect(
      (await createPersonalToken(owner, { name: "Owner CLI", spaceId })).status,
    ).toBe(201);

    const memberTokens = await listPersonalTokens(member);
    const ownerTokens = await listPersonalTokens(owner);

    expect(memberTokens.map((token) => token.name)).toEqual(["Member CLI"]);
    expect(ownerTokens.map((token) => token.name)).toEqual(["Owner CLI"]);
    expect(memberTokens[0]?.spaceId).toBe(spaceId);
    expect(memberTokens[0]?.spaceName).toBe("Personal Tokens");
    expect(memberTokens[0]?.resources[0]?.permission).toBe("editor");
  });

  it("refuses a space the caller holds no role on", async () => {
    const response = await createPersonalToken(outsider, {
      name: "Outsider CLI",
      spaceId,
    });
    expect(response.status).toBe(403);
    expect(await listPersonalTokens(outsider)).toEqual([]);
  });

  it("keeps one caller's tokens out of another's reach", async () => {
    const [memberToken] = await listPersonalTokens(member);
    expect(memberToken).toBeDefined();

    for (const method of ["PATCH", "DELETE"] as const) {
      const response = await apiRequest(
        `/api/v1/access-tokens/${memberToken?.id}`,
        owner.token,
        { method },
      );
      expect(response.status).toBe(404);
    }

    expect((await listPersonalTokens(member))[0]?.revokedAt).toBeNull();
  });

  it("revokes and then deletes the caller's own token", async () => {
    const created = await (
      await createPersonalToken(member, { name: "Throwaway", spaceId })
    ).json();
    expect((await listDocumentsWithToken(created.token)).status).toBe(200);

    const revoked = await apiRequest(
      `/api/v1/access-tokens/${created.id}`,
      member.token,
      { method: "PATCH" },
    );
    expect(revoked.status).toBe(200);
    expect((await listDocumentsWithToken(created.token)).status).toBe(401);
    expect(
      (await listPersonalTokens(member)).find((token) => token.id === created.id)
        ?.revokedAt,
    ).not.toBeNull();

    const deleted = await apiRequest(
      `/api/v1/access-tokens/${created.id}`,
      member.token,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    expect((await listPersonalTokens(member)).map((token) => token.id)).not.toContain(
      created.id,
    );
  });

  it("rejects a nameless token and an out-of-range expiry", async () => {
    expect((await createPersonalToken(member, { name: "  ", spaceId })).status).toBe(400);
    expect(
      (
        await createPersonalToken(member, {
          name: "Too long",
          spaceId,
          expiresInDays: 4000,
        })
      ).status,
    ).toBe(400);
  });
});
