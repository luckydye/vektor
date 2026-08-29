/**
 * SSH login is the CLI's way in where there is no browser, so it has to be worth
 * as much trust as the browser flow and no more: a signature over a challenge
 * this server issued, a key its owner registered, and a token carrying exactly
 * the role that user already holds.
 *
 * These specs drive the real three steps — register, challenge, exchange —
 * against a running server, and then use what comes out.
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
import { generateEd25519Key, type TestSshKey } from "./helpers/sshKeys.ts";

const PORT = 7494;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);

let serverProcess: TestServerProcess;

interface User {
  id: string;
  token: string;
}

/** Holds a role on one space, so a login needs no space named. */
let editor: User;
let viewer: User;
/** Owns two spaces, so a login has to be told which one. */
let owner: User;
let spaceId: string;
let secondSpaceId: string;

async function createUser(name: string): Promise<User> {
  const created = await createTestUser(BASE_URL, name, "test-cli-ssh");
  return { id: created.userId, token: created.token };
}

async function createSpace(user: User, name: string): Promise<string> {
  const response = await apiRequest("/api/v1/spaces", user.token, {
    method: "POST",
    body: JSON.stringify({ name, slug: `${name}-${Date.now()}` }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).space.id;
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

// ---------------------------------------------------------------------------
// The flow, driven exactly as the CLI drives it
// ---------------------------------------------------------------------------

function registerKey(user: User, key: TestSshKey, name?: string): Promise<Response> {
  return apiRequest("/api/v1/users/ssh-keys", user.token, {
    method: "POST",
    body: JSON.stringify({ publicKey: key.line, ...(name ? { name } : {}) }),
  });
}

async function requestChallenge(): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/v1/auth/cli/ssh/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.namespace).toBe("vektor-cli");
  return body.challenge;
}

function exchange(body: {
  challenge: string;
  signature: string;
  spaceId?: string;
}): Promise<Response> {
  return fetch(`${BASE_URL}/api/v1/auth/cli/ssh/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function sshLogin(key: TestSshKey, selectedSpaceId?: string): Promise<Response> {
  const challenge = await requestChallenge();
  return exchange({
    challenge,
    signature: key.sign(challenge),
    ...(selectedSpaceId ? { spaceId: selectedSpaceId } : {}),
  });
}

function tokenRequest(path: string, token: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  return fetch(`${BASE_URL}${path}`, { ...options, headers });
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET:
      process.env.AUTH_SECRET ?? "cli-ssh-test-secret-do-not-use-in-production",
  });
  await waitForServer(BASE_URL);

  owner = await createUser("SSH Owner");
  editor = await createUser("SSH Editor");
  viewer = await createUser("SSH Viewer");

  spaceId = await createSpace(owner, "ssh-space");
  secondSpaceId = await createSpace(owner, "ssh-other-space");

  await grantRole(editor.id, "editor");
  await grantRole(viewer.id, "viewer");
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("SSH key registration", () => {
  it("stores the key under its fingerprint and lists it back", async () => {
    const key = generateEd25519Key("editor@laptop");
    const created = await registerKey(editor, key, "Laptop");
    expect(created.status).toBe(201);

    const { key: stored } = await created.json();
    expect(stored.name).toBe("Laptop");
    expect(stored.keyType).toBe("ssh-ed25519");
    expect(stored.fingerprint).toMatch(/^SHA256:/);
    expect(stored.lastUsedAt).toBeNull();

    const listed = await apiRequest("/api/v1/users/ssh-keys", editor.token);
    expect(listed.status).toBe(200);
    const { keys } = await listed.json();
    expect(keys.map((entry: { id: string }) => entry.id)).toContain(stored.id);
  });

  it("names the key after the line's comment when no name is given", async () => {
    const response = await registerKey(viewer, generateEd25519Key("viewer@desktop"));
    expect(response.status).toBe(201);
    expect((await response.json()).key.name).toBe("viewer@desktop");
  });

  it("rejects a key that is not a public key", async () => {
    const response = await apiRequest("/api/v1/users/ssh-keys", editor.token, {
      method: "POST",
      body: JSON.stringify({ publicKey: "-----BEGIN OPENSSH PRIVATE KEY-----" }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses to register the same key twice", async () => {
    const key = generateEd25519Key();
    expect((await registerKey(owner, key)).status).toBe(201);

    const again = await registerKey(viewer, key);
    expect(again.status).toBe(400);
    expect((await again.json()).error).toMatch(/already registered/);
  });

  /**
   * A key logs in to every space its owner can reach, so a token scoped to one
   * space must not be able to register one — that would be an escalation.
   */
  it("cannot be registered with an access token, only a session", async () => {
    const minted = await apiRequest("/api/v1/access-tokens", editor.token, {
      method: "POST",
      body: JSON.stringify({ name: "ssh-escalation", spaceId }),
    });
    expect(minted.status).toBe(201);
    const { token } = await minted.json();

    const response = await tokenRequest("/api/v1/users/ssh-keys", token, {
      method: "POST",
      body: JSON.stringify({ publicKey: generateEd25519Key().line }),
    });
    expect(response.status).toBe(401);
  });

  it("cannot be listed by an anonymous caller", async () => {
    const response = await fetch(`${BASE_URL}/api/v1/users/ssh-keys`);
    expect(response.status).toBe(401);
  });
});

describe("SSH login", () => {
  it("mints a token carrying the key owner's role", async () => {
    const key = generateEd25519Key();
    expect((await registerKey(editor, key)).status).toBe(201);

    const response = await sshLogin(key);
    expect(response.status).toBe(200);

    const result = await response.json();
    expect(result.spaceId).toBe(spaceId);
    expect(result.permission).toBe("editor");
    expect(result.token).toMatch(/^at_/);

    const created = await tokenRequest(
      `/api/v1/spaces/${spaceId}/documents`,
      result.token,
      {
        method: "POST",
        body: JSON.stringify({ content: "<p>via ssh</p>", properties: { title: "SSH" } }),
      },
    );
    expect(created.status).toBe(201);
  });

  it("delegates a viewer's role and no more", async () => {
    const key = generateEd25519Key();
    expect((await registerKey(viewer, key)).status).toBe(201);

    const response = await sshLogin(key);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.permission).toBe("viewer");

    const created = await tokenRequest(
      `/api/v1/spaces/${spaceId}/documents`,
      result.token,
      {
        method: "POST",
        body: JSON.stringify({ content: "<p>nope</p>", properties: { title: "Nope" } }),
      },
    );
    expect(created.status).toBe(403);
  });

  it("records the login against the key", async () => {
    const key = generateEd25519Key();
    const created = await registerKey(editor, key, "Used key");
    const keyId = (await created.json()).key.id;

    expect((await sshLogin(key)).status).toBe(200);

    const listed = await apiRequest("/api/v1/users/ssh-keys", editor.token);
    const keys = (await listed.json()).keys as Array<{ id: string; lastUsedAt: string }>;
    expect(keys.find((entry) => entry.id === keyId)?.lastUsedAt).not.toBeNull();
  });

  it("rejects a key nobody registered, naming its fingerprint", async () => {
    const response = await sshLogin(generateEd25519Key());
    expect(response.status).toBe(401);
    expect((await response.json()).error).toMatch(/SHA256:.*not registered/);
  });

  it("rejects a signature made over a different challenge", async () => {
    const key = generateEd25519Key();
    expect((await registerKey(editor, key)).status).toBe(201);

    const response = await exchange({
      challenge: await requestChallenge(),
      signature: key.sign("a challenge this server never issued"),
    });
    expect(response.status).toBe(401);
  });

  it("spends a challenge on its first use", async () => {
    const key = generateEd25519Key();
    expect((await registerKey(editor, key)).status).toBe(201);

    const challenge = await requestChallenge();
    const signature = key.sign(challenge);
    expect((await exchange({ challenge, signature })).status).toBe(200);

    const replayed = await exchange({ challenge, signature });
    expect(replayed.status).toBe(400);
    expect((await replayed.json()).error).toMatch(/expired|Invalid/);
  });

  it("asks which space when the key opens several", async () => {
    const key = generateEd25519Key();
    expect((await registerKey(owner, key)).status).toBe(201);

    const ambiguous = await sshLogin(key);
    expect(ambiguous.status).toBe(400);
    const failure = await ambiguous.json();
    expect(failure.error).toBe("space_required");
    expect(failure.spaces.map((space: { id: string }) => space.id).sort()).toEqual(
      [spaceId, secondSpaceId].sort(),
    );

    const chosen = await sshLogin(key, secondSpaceId);
    expect(chosen.status).toBe(200);
    expect((await chosen.json()).spaceId).toBe(secondSpaceId);
  });

  it("stops working once the key is deleted", async () => {
    const key = generateEd25519Key();
    const created = await registerKey(editor, key);
    const keyId = (await created.json()).key.id;

    const deleted = await apiRequest(`/api/v1/users/ssh-keys/${keyId}`, editor.token, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);

    expect((await sshLogin(key)).status).toBe(401);
  });

  it("does not let one user delete another's key", async () => {
    const key = generateEd25519Key();
    const created = await registerKey(editor, key);
    const keyId = (await created.json()).key.id;

    const response = await apiRequest(`/api/v1/users/ssh-keys/${keyId}`, viewer.token, {
      method: "DELETE",
    });
    expect(response.status).toBe(404);

    expect((await sshLogin(key)).status).toBe(200);
  });
});
