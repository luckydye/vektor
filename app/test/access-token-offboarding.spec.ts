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

const PORT = 7521;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let owner: TestUserSession;
let delegate: TestUserSession;
let spaceId: string;
let documentId: string;

async function grantDelegateOwnership(): Promise<void> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/permissions`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "owner",
        action: "grant",
        userId: delegate.userId,
      }),
    },
  );
  expect(response.status).toBe(200);
}

async function removeDelegate(): Promise<void> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/permissions`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "owner",
        action: "revoke",
        userId: delegate.userId,
      }),
    },
  );
  expect(response.status).toBe(200);
}

async function createDelegateToken(name: string): Promise<{ id: string; token: string }> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/access-tokens`,
    delegate.token,
    {
      method: "POST",
      body: JSON.stringify({
        name,
        resourceType: "space",
        resourceId: spaceId,
        permission: "editor",
      }),
    },
  );
  expect(response.status).toBe(201);
  return await response.json();
}

function readDocumentWithToken(token: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/documents/${documentId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function expectRevoked(token: { id: string; token: string }): Promise<void> {
  expect((await readDocumentWithToken(token.token)).status).toBe(401);

  const metadata = await apiRequest(
    `/api/v1/spaces/${spaceId}/access-tokens/${token.id}`,
    owner.token,
  );
  expect(metadata.status).toBe(200);
  expect((await metadata.json()).token.revokedAt).not.toBeNull();
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "token-offboarding-test-secret",
  });
  await waitForServer(BASE_URL);

  owner = await createTestUser(BASE_URL, "Token Owner", "test-token-offboarding");
  delegate = await createTestUser(
    BASE_URL,
    "Token Delegate",
    "test-token-offboarding",
  );

  const spaceResponse = await apiRequest("/api/v1/spaces", owner.token, {
    method: "POST",
    body: JSON.stringify({
      name: "Token Offboarding",
      slug: `token-offboarding-${Date.now()}`,
    }),
  });
  expect(spaceResponse.status).toBe(201);
  spaceId = (await spaceResponse.json()).space.id;

  const documentResponse = await apiRequest(
    `/api/v1/spaces/${spaceId}/documents`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        content: "# Offboarding secret",
        properties: { title: "Offboarding secret" },
      }),
    },
  );
  expect(documentResponse.status).toBe(201);
  documentId = (await documentResponse.json()).document.id;
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("access-token creator lifecycle", () => {
  it("permanently revokes delegated tokens when their creator is removed", async () => {
    await grantDelegateOwnership();
    const token = await createDelegateToken("before removal");
    expect((await readDocumentWithToken(token.token)).status).toBe(200);

    await removeDelegate();
    await expectRevoked(token);
    expect(
      (
        await apiRequest(
          `/api/v1/spaces/${spaceId}/documents/${documentId}`,
          delegate.token,
        )
      ).status,
    ).toBe(403);
  });
});
