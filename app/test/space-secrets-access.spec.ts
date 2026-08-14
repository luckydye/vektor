import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSessionApiRequest,
  createTestUser,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7510;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);

const PROTECTED_SECRET_NAME = "DEPLOY_TOKEN";
const PROTECTED_SECRET_VALUE = "owner-only-value";
const AI_API_KEY = "sk-test-internal-secret";

let serverProcess: TestServerProcess;
let spaceId: string;
let ownerToken: string;
let editorToken: string;
let viewerToken: string;
let outsiderToken: string;

function secretsPath(name?: string): string {
  const collection = `/api/v1/spaces/${spaceId}/secrets`;
  return name ? `${collection}/${encodeURIComponent(name)}` : collection;
}

async function grantRole(
  userId: string,
  roleOrFeature: "editor" | "viewer",
): Promise<void> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/permissions`,
    ownerToken,
    {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature,
        userId,
        action: "grant",
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to grant ${roleOrFeature} (${response.status}): ${await response.text()}`,
    );
  }
}

beforeAll(async () => {
  process.env.AUTH_SECRET ??= "space-secrets-test-secret-do-not-use-in-production";
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    VEKTOR_API_ONLY: "1",
    AUTH_SECRET: process.env.AUTH_SECRET,
  });
  await waitForServer(BASE_URL);

  const owner = await createTestUser(BASE_URL, "Secrets Owner", "secrets-owner");
  const editor = await createTestUser(BASE_URL, "Secrets Editor", "secrets-editor");
  const viewer = await createTestUser(BASE_URL, "Secrets Viewer", "secrets-viewer");
  const outsider = await createTestUser(
    BASE_URL,
    "Secrets Outsider",
    "secrets-outsider",
  );
  ownerToken = owner.token;
  editorToken = editor.token;
  viewerToken = viewer.token;
  outsiderToken = outsider.token;

  const spaceResponse = await apiRequest("/api/v1/spaces", ownerToken, {
    method: "POST",
    body: JSON.stringify({
      name: "Secrets Access Space",
      slug: `secrets-access-${Date.now()}`,
    }),
  });
  if (!spaceResponse.ok) {
    throw new Error(`Failed to create space (${spaceResponse.status})`);
  }
  spaceId = (await spaceResponse.json()).space.id;

  await grantRole(editor.userId, "editor");
  await grantRole(viewer.userId, "viewer");

  const secretResponse = await apiRequest(secretsPath(), ownerToken, {
    method: "POST",
    body: JSON.stringify({
      name: PROTECTED_SECRET_NAME,
      value: PROTECTED_SECRET_VALUE,
    }),
  });
  if (!secretResponse.ok) {
    throw new Error(`Failed to create protected secret (${secretResponse.status})`);
  }

  const aiResponse = await apiRequest(
    `/api/v1/spaces/${spaceId}/settings/ai-provider`,
    ownerToken,
    {
      method: "PUT",
      body: JSON.stringify({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: AI_API_KEY,
      }),
    },
  );
  if (!aiResponse.ok) {
    throw new Error(`Failed to configure AI provider (${aiResponse.status})`);
  }
});

afterAll(() => {
  serverProcess?.kill();
});

describe("space secret access", () => {
  it("allows an owner to manage and reveal secrets", async () => {
    const name = "OWNER_CRUD_SECRET";
    const initialValue = "initial-owner-value";
    const rotatedValue = "rotated-owner-value";

    const createResponse = await apiRequest(secretsPath(), ownerToken, {
      method: "POST",
      body: JSON.stringify({ name, value: initialValue }),
    });
    expect(createResponse.status).toBe(201);

    const listResponse = await apiRequest(secretsPath(), ownerToken);
    expect(listResponse.status).toBe(200);
    expect((await listResponse.json()).secrets).toContainEqual(
      expect.objectContaining({ name }),
    );

    const readResponse = await apiRequest(secretsPath(name), ownerToken);
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toEqual({ name, value: initialValue });

    const headResponse = await apiRequest(secretsPath(name), ownerToken, {
      method: "HEAD",
    });
    expect(headResponse.status).toBe(200);

    const updateResponse = await apiRequest(secretsPath(name), ownerToken, {
      method: "PUT",
      body: JSON.stringify({ value: rotatedValue }),
    });
    expect(updateResponse.status).toBe(200);

    const rotatedResponse = await apiRequest(secretsPath(name), ownerToken);
    expect(await rotatedResponse.json()).toEqual({ name, value: rotatedValue });

    const deleteResponse = await apiRequest(secretsPath(name), ownerToken, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);
  });

  for (const role of ["editor", "viewer", "outsider"] as const) {
    it(`denies every secret endpoint to a space ${role}`, async () => {
      const token =
        role === "editor"
          ? editorToken
          : role === "viewer"
            ? viewerToken
            : outsiderToken;
      const attempts: Array<{ path: string; init?: RequestInit }> = [
        { path: secretsPath() },
        {
          path: secretsPath(),
          init: {
            method: "POST",
            body: JSON.stringify({ name: `${role}_secret`, value: "forbidden" }),
          },
        },
        { path: secretsPath(PROTECTED_SECRET_NAME) },
        { path: secretsPath(PROTECTED_SECRET_NAME), init: { method: "HEAD" } },
        {
          path: secretsPath(PROTECTED_SECRET_NAME),
          init: { method: "PUT", body: JSON.stringify({ value: "forbidden" }) },
        },
        { path: secretsPath(PROTECTED_SECRET_NAME), init: { method: "DELETE" } },
      ];

      for (const attempt of attempts) {
        const response = await apiRequest(attempt.path, token, attempt.init);
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain(PROTECTED_SECRET_VALUE);
      }
    });
  }

  it("keeps namespaced application secrets outside the owner-facing API", async () => {
    const internalName = "secrets:ai_api_key";

    const listResponse = await apiRequest(secretsPath(), ownerToken);
    expect(listResponse.status).toBe(200);
    expect((await listResponse.json()).secrets).not.toContainEqual(
      expect.objectContaining({ name: internalName }),
    );

    for (const method of ["GET", "HEAD", "DELETE"] as const) {
      const response = await apiRequest(secretsPath(internalName), ownerToken, {
        method,
      });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(AI_API_KEY);
    }

    const settingsResponse = await apiRequest(
      `/api/v1/spaces/${spaceId}/settings/ai-provider`,
      ownerToken,
    );
    expect(settingsResponse.status).toBe(200);
    expect(await settingsResponse.json()).toMatchObject({
      aiProvider: { configured: true, hasApiKey: true },
    });
  });

  it("reserves the former internal-secret naming convention", async () => {
    const response = await apiRequest(secretsPath(), ownerToken, {
      method: "POST",
      body: JSON.stringify({ name: "__internal", value: "not-user-managed" }),
    });

    expect(response.status).toBe(400);
  });
});
