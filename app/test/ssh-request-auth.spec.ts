/**
 * SSH authentication end to end, against a running server.
 *
 * The claim under test is that a signature is worth exactly one request: it
 * authenticates the caller as the user who registered the key, and it does so
 * for that method, that path and that body, once. Everything else here is a way
 * of trying to get more out of one than that.
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
import { generateEd25519Key, signRequest, type TestSshKey } from "./helpers/sshKeys.ts";

const PORT = 7494;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);

let serverProcess: TestServerProcess;

interface User {
  id: string;
  token: string;
}

let owner: User;
let editor: User;
let viewer: User;
let spaceId: string;

async function createUser(name: string): Promise<User> {
  const created = await createTestUser(BASE_URL, name, "test-ssh-auth");
  return { id: created.userId, token: created.token };
}

async function grantRole(userId: string, role: string): Promise<void> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/permissions`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: role,
        userId,
        action: "grant",
      }),
    },
  );
  expect([200, 201]).toContain(response.status);
}

function registerKey(user: User, key: TestSshKey, name?: string): Promise<Response> {
  return apiRequest("/api/v1/users/ssh-keys", user.token, {
    method: "POST",
    body: JSON.stringify({ publicKey: key.line, ...(name ? { name } : {}) }),
  });
}

/** One signed request, exactly as the CLI would send it. */
function signed(
  key: TestSshKey,
  path: string,
  options: { method?: string; body?: string; authorization?: string } = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.set(
    "Authorization",
    options.authorization ?? signRequest(key, { method, path, body: options.body }),
  );
  return fetch(`${BASE_URL}${path}`, { method, headers, body: options.body });
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET:
      process.env.AUTH_SECRET ?? "ssh-auth-test-secret-do-not-use-in-production",
  });
  await waitForServer(BASE_URL);

  owner = await createUser("SSH Owner");
  editor = await createUser("SSH Editor");
  viewer = await createUser("SSH Viewer");

  const space = await apiRequest("/api/v1/spaces", owner.token, {
    method: "POST",
    body: JSON.stringify({ name: "ssh-space", slug: `ssh-space-${Date.now()}` }),
  });
  expect(space.status).toBe(201);
  spaceId = (await space.json()).space.id;

  await grantRole(editor.id, "editor");
  await grantRole(viewer.id, "viewer");
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("registering a key", () => {
  it("stores it under its fingerprint and lists it back", async () => {
    const key = generateEd25519Key("editor@laptop");
    const created = await registerKey(editor, key, "Laptop");
    expect(created.status).toBe(201);

    const stored = (await created.json()).key;
    expect(stored.keyType).toBe("ssh-ed25519");
    expect(stored.fingerprint).toMatch(/^SHA256:/);
    expect(stored.lastUsedAt).toBeNull();

    const listed = await apiRequest("/api/v1/users/ssh-keys", editor.token);
    const { keys } = await listed.json();
    expect(keys.map((entry: { id: string }) => entry.id)).toContain(stored.id);
  });

  it("names the key after the line's comment when no name is given", async () => {
    const response = await registerKey(viewer, generateEd25519Key("viewer@desktop"));
    expect((await response.json()).key.name).toBe("viewer@desktop");
  });

  it("rejects something that is not a public key", async () => {
    const response = await apiRequest("/api/v1/users/ssh-keys", editor.token, {
      method: "POST",
      body: JSON.stringify({ publicKey: "-----BEGIN OPENSSH PRIVATE KEY-----" }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses the same key twice", async () => {
    const key = generateEd25519Key();
    expect((await registerKey(owner, key)).status).toBe(201);

    const again = await registerKey(viewer, key);
    expect(again.status).toBe(400);
    expect((await again.json()).error).toMatch(/already registered/);
  });

  /**
   * A key authenticates every space its owner can reach, so a signature must
   * not be able to add another one — a stolen key would outlive the removal of
   * the key that was stolen.
   */
  it("cannot be done with a signature, only with a session", async () => {
    const key = generateEd25519Key();
    expect((await registerKey(editor, key)).status).toBe(201);

    const response = await signed(key, "/api/v1/users/ssh-keys", {
      method: "POST",
      body: JSON.stringify({ publicKey: generateEd25519Key().line }),
    });
    expect(response.status).toBe(403);
  });

  it("cannot be listed by an anonymous caller", async () => {
    expect((await fetch(`${BASE_URL}/api/v1/users/ssh-keys`)).status).toBe(401);
  });
});

describe("signed requests", () => {
  let editorKey: TestSshKey;

  beforeAll(async () => {
    editorKey = generateEd25519Key();
    expect((await registerKey(editor, editorKey, "Signing key")).status).toBe(201);
  });

  it("authenticates as the user who registered the key", async () => {
    const response = await signed(editorKey, "/api/v1/users/me");
    expect(response.status).toBe(200);
    expect((await response.json()).id).toBe(editor.id);
  });

  it("carries the signer's own role, and no more", async () => {
    const body = JSON.stringify({
      content: "<p>signed</p>",
      properties: { title: "Signed" },
    });
    const created = await signed(editorKey, `/api/v1/spaces/${spaceId}/documents`, {
      method: "POST",
      body,
    });
    expect(created.status).toBe(201);

    const viewerKey = generateEd25519Key();
    expect((await registerKey(viewer, viewerKey)).status).toBe(201);

    const refused = await signed(viewerKey, `/api/v1/spaces/${spaceId}/documents`, {
      method: "POST",
      body,
    });
    expect(refused.status).toBe(403);
  });

  it("is worth one request: the same signature does not authenticate a second", async () => {
    const authorization = signRequest(editorKey, {
      method: "GET",
      path: "/api/v1/users/me",
    });

    expect((await signed(editorKey, "/api/v1/users/me", { authorization })).status).toBe(
      200,
    );
    expect((await signed(editorKey, "/api/v1/users/me", { authorization })).status).toBe(
      401,
    );
  });

  it("does not authenticate a different path", async () => {
    const authorization = signRequest(editorKey, {
      method: "GET",
      path: "/api/v1/users/me",
    });

    const response = await signed(editorKey, `/api/v1/spaces/${spaceId}/documents`, {
      authorization,
    });
    expect(response.status).toBe(401);
  });

  it("does not authenticate a body it did not cover", async () => {
    const path = `/api/v1/spaces/${spaceId}/documents`;
    const authorization = signRequest(editorKey, {
      method: "POST",
      path,
      body: JSON.stringify({ content: "<p>signed</p>", properties: { title: "One" } }),
    });

    const response = await signed(editorKey, path, {
      method: "POST",
      authorization,
      body: JSON.stringify({ content: "<p>swapped</p>", properties: { title: "Two" } }),
    });
    expect(response.status).toBe(401);
  });

  it("refuses a signature that is older than the skew window", async () => {
    const authorization = signRequest(
      editorKey,
      { method: "GET", path: "/api/v1/users/me" },
      { timestamp: Math.floor(Date.now() / 1000) - 3600 },
    );

    expect((await signed(editorKey, "/api/v1/users/me", { authorization })).status).toBe(
      401,
    );
  });

  it("refuses a key nobody registered", async () => {
    const response = await signed(generateEd25519Key(), "/api/v1/users/me");
    expect(response.status).toBe(401);
  });

  it("records the key's last use", async () => {
    const key = generateEd25519Key();
    const created = await registerKey(editor, key, "Used key");
    const keyId = (await created.json()).key.id;

    expect((await signed(key, "/api/v1/users/me")).status).toBe(200);

    const listed = await apiRequest("/api/v1/users/ssh-keys", editor.token);
    const keys = (await listed.json()).keys as Array<{ id: string; lastUsedAt: string }>;
    expect(keys.find((entry) => entry.id === keyId)?.lastUsedAt).not.toBeNull();
  });

  it("stops authenticating once the key is deleted", async () => {
    const key = generateEd25519Key();
    const created = await registerKey(editor, key);
    const keyId = (await created.json()).key.id;

    expect((await signed(key, "/api/v1/users/me")).status).toBe(200);

    const deleted = await apiRequest(`/api/v1/users/ssh-keys/${keyId}`, editor.token, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);

    expect((await signed(key, "/api/v1/users/me")).status).toBe(401);
  });

  it("does not let one user delete another's key", async () => {
    const key = generateEd25519Key();
    const created = await registerKey(editor, key);
    const keyId = (await created.json()).key.id;

    const response = await apiRequest(`/api/v1/users/ssh-keys/${keyId}`, viewer.token, {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
    expect((await signed(key, "/api/v1/users/me")).status).toBe(200);
  });
});
