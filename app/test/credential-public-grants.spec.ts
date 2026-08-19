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

/**
 * What a credential resolves against, which is `public` and its own grants.
 *
 * An empty group set is read as `[public]` by every ACL query that takes one, so
 * a token reaches world-readable pages exactly like an anonymous caller does —
 * strictly less than the person who issued it. Pinned because it is easy to
 * mistake for a leak and "fix", and because the `token_` test that used to sit in
 * `aclGroups` claimed the opposite while changing nothing.
 */

const PORT = 7530;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let owner: TestUserSession;
let spaceId: string;
let scopedDocumentId: string;
let publicDocumentId: string;
let privateDocumentId: string;
let scopedToken: string;

function readWithToken(documentId: string, token: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/documents/${documentId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function createDocument(title: string): Promise<string> {
  const response = await apiRequest(`/api/v1/spaces/${spaceId}/documents`, owner.token, {
    method: "POST",
    body: JSON.stringify({ content: `# ${title}`, properties: { title } }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).document.id;
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "credential-public-grants-secret",
  });
  await waitForServer(BASE_URL);

  owner = await createTestUser(BASE_URL, "Grant Owner", "test-credential-public");

  const space = await apiRequest("/api/v1/spaces", owner.token, {
    method: "POST",
    body: JSON.stringify({
      name: "Credential Public Grants",
      slug: `credential-public-${Date.now()}`,
    }),
  });
  expect(space.status).toBe(201);
  spaceId = (await space.json()).space.id;

  scopedDocumentId = await createDocument("the token's own page");
  publicDocumentId = await createDocument("world readable");
  privateDocumentId = await createDocument("owner only");

  const shared = await apiRequest(`/api/v1/spaces/${spaceId}/permissions`, owner.token, {
    method: "POST",
    body: JSON.stringify({
      type: "role",
      roleOrFeature: "viewer",
      action: "grant",
      groupId: "public",
      resourceType: "document",
      resourceId: publicDocumentId,
    }),
  });
  expect(shared.status).toBe(200);

  const created = await apiRequest(
    `/api/v1/spaces/${spaceId}/access-tokens`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        name: "scoped to one page",
        resourceType: "document",
        resourceId: scopedDocumentId,
        permission: "editor",
      }),
    },
  );
  expect(created.status).toBe(201);
  scopedToken = (await created.json()).token;
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("a credential's group grants", () => {
  it("reads the page its own grant names", async () => {
    expect((await readWithToken(scopedDocumentId, scopedToken)).status).toBe(200);
  });

  it("reads a world-readable page, as an anonymous caller would", async () => {
    expect((await readWithToken(publicDocumentId, scopedToken)).status).toBe(200);
    const anonymous = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/documents/${publicDocumentId}`,
    );
    expect(anonymous.status).toBe(200);
  });

  it("does not reach a page only its issuer can see", async () => {
    expect((await readWithToken(privateDocumentId, scopedToken)).status).toBe(403);
  });

  it("lists exactly those two pages and no others", async () => {
    const response = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/documents?limit=100`,
      { headers: { Authorization: `Bearer ${scopedToken}` } },
    );
    expect(response.status).toBe(200);

    const ids = (await response.json()).documents.map((d: { id: string }) => d.id);
    expect(ids).toContain(scopedDocumentId);
    expect(ids).toContain(publicDocumentId);
    expect(ids).not.toContain(privateDocumentId);
  });
});
