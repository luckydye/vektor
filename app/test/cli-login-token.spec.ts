/**
 * The CLI login flow is a token mint, so it is a delegation: the token it hands
 * the terminal must carry exactly the role the approving user holds on the
 * selected space, and no more.
 *
 * It used to hardcode `editor` for everyone, which turned "I can see this space"
 * into "I can write to it" for any viewer — and even for someone who reached the
 * space through a single shared document. These specs drive the real three-step
 * flow (approval page → one-time code → token exchange) for each role and check
 * what the resulting token can actually do.
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

const PORT = 7493;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);
const REDIRECT_URI = "http://127.0.0.1:9999/callback";
const STATE = "clitokenstate1234567890";

let serverProcess: TestServerProcess;

interface User {
  id: string;
  token: string;
}

let owner: User;
let editor: User;
let viewer: User;
/** Holds no space-wide role in `spaceId` — only a grant on one document. */
let docGrantee: User;
let spaceId: string;
let documentId: string;
/** A space `docGrantee` owns, so the approval page has something to render. */
let docGranteeSpaceId: string;

async function createUser(name: string): Promise<User> {
  const created = await createTestUser(BASE_URL, name, "test-cli-token");
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

async function grant(options: {
  role: string;
  userId: string;
  resourceType?: string;
  resourceId?: string;
}): Promise<void> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/permissions`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: options.role,
        userId: options.userId,
        resourceType: options.resourceType,
        resourceId: options.resourceId,
        action: "grant",
      }),
    },
  );
  expect([200, 201]).toContain(response.status);
}

async function revokeSpaceRole(role: string, userId: string): Promise<void> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/permissions`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: role,
        userId,
        action: "revoke",
      }),
    },
  );
  expect(response.status).toBe(200);
}

// ---------------------------------------------------------------------------
// The CLI flow, driven exactly as a browser drives it
// ---------------------------------------------------------------------------

/** Step 1: the approval page (or a redirect back to the CLI when nothing is offered). */
function requestApprovalPage(user: User): Promise<Response> {
  return fetch(
    `${BASE_URL}/api/v1/auth/cli?redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${STATE}`,
    {
      headers: { Cookie: `vektor.session_token=${user.token}` },
      redirect: "manual",
    },
  );
}

async function approvalTokenFor(user: User): Promise<{ html: string; approval: string }> {
  const response = await requestApprovalPage(user);
  expect(response.status).toBe(200);
  const html = await response.text();
  const approval = html.match(/name="approval" value="([\da-f]+)"/)?.[1];
  expect(approval).toBeDefined();
  return { html, approval: approval as string };
}

/** Step 2: submit the approval form for `selectedSpaceId`. */
async function approve(user: User, selectedSpaceId: string): Promise<Response> {
  const { approval } = await approvalTokenFor(user);
  return fetch(`${BASE_URL}/api/v1/auth/cli`, {
    method: "POST",
    headers: {
      Cookie: `vektor.session_token=${user.token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      redirect_uri: REDIRECT_URI,
      state: STATE,
      approval,
      intent: "allow",
      spaceId: selectedSpaceId,
    }).toString(),
    redirect: "manual",
  });
}

/** Step 2, returning the one-time code the callback page carries. */
async function approvalCode(user: User, selectedSpaceId: string): Promise<string> {
  const response = await approve(user, selectedSpaceId);
  expect(response.status).toBe(200);
  const code = (await response.text()).match(/code=([\da-f]{64})/)?.[1];
  expect(code).toBeDefined();
  return code as string;
}

/** Step 3: exchange the code for a token. */
function exchange(code: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/v1/auth/cli/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

interface CliToken {
  token: string;
  spaceId: string;
  permission: string;
  expiresAt: string;
}

async function cliLogin(user: User, selectedSpaceId = spaceId): Promise<CliToken> {
  const response = await exchange(await approvalCode(user, selectedSpaceId));
  expect(response.status).toBe(200);
  return (await response.json()) as CliToken;
}

function tokenRequest(
  path: string,
  token: string,
  options: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  return fetch(`${BASE_URL}${path}`, { ...options, headers });
}

/** The editor action the audit used as its proof: creating a document. */
function createDocumentWithToken(token: string, title: string): Promise<Response> {
  return tokenRequest(`/api/v1/spaces/${spaceId}/documents`, token, {
    method: "POST",
    body: JSON.stringify({ content: `<p>${title}</p>`, properties: { title } }),
  });
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET:
      process.env.AUTH_SECRET ?? "cli-token-test-secret-do-not-use-in-production",
  });
  await waitForServer(BASE_URL);

  owner = await createUser("CLI Owner");
  editor = await createUser("CLI Editor");
  viewer = await createUser("CLI Viewer");
  docGrantee = await createUser("CLI Doc Grantee");

  spaceId = await createSpace(owner, "cli-token-space");
  docGranteeSpaceId = await createSpace(docGrantee, "cli-token-own-space");

  const docResponse = await apiRequest(
    `/api/v1/spaces/${spaceId}/documents`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        content: "<p>shared</p>",
        properties: { title: "Shared Document" },
      }),
    },
  );
  expect(docResponse.status).toBe(201);
  documentId = (await docResponse.json()).document.id;

  await grant({ role: "editor", userId: editor.id });
  await grant({ role: "viewer", userId: viewer.id });
  // No space-wide role for docGrantee — a single document grant only.
  await grant({
    role: "viewer",
    userId: docGrantee.id,
    resourceType: "document",
    resourceId: documentId,
  });
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("CLI login mints a token at the user's actual role", () => {
  it("gives a space viewer a viewer token, not an editor one", async () => {
    const cli = await cliLogin(viewer);
    expect(cli.permission).toBe("viewer");
  });

  it("does not let a viewer's CLI token perform editor actions", async () => {
    const cli = await cliLogin(viewer);

    // The session is denied this action…
    const session = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents`,
      viewer.token,
      {
        method: "POST",
        body: JSON.stringify({ content: "<p>via session</p>" }),
      },
    );
    expect(session.status).toBe(403);

    // …and so is the token the CLI flow issued (this was a 201 before the fix).
    const write = await createDocumentWithToken(cli.token, "Escalated");
    expect(write.status).toBe(403);
  });

  it("still lets a viewer's CLI token read the space", async () => {
    const cli = await cliLogin(viewer);
    const read = await tokenRequest(`/api/v1/spaces/${spaceId}/documents`, cli.token);
    expect(read.status).toBe(200);
  });

  it("gives a space editor an editor token that can write", async () => {
    const cli = await cliLogin(editor);
    expect(cli.permission).toBe("editor");

    const write = await createDocumentWithToken(cli.token, "Editor Created");
    expect(write.status).toBe(201);
  });

  it("gives the space owner an owner token", async () => {
    const cli = await cliLogin(owner);
    expect(cli.permission).toBe("owner");
  });

  it("re-resolves the role at exchange time, refusing a role revoked after approval", async () => {
    const temporary = await createUser("CLI Temporary Editor");
    await grant({ role: "editor", userId: temporary.id });

    const code = await approvalCode(temporary, spaceId);
    await revokeSpaceRole("editor", temporary.id);

    const response = await exchange(code);
    expect(response.status).toBe(403);
  });
});

describe("CLI login and resource-scoped grantees", () => {
  it("does not offer a space the user only reaches through a document grant", async () => {
    const { html } = await approvalTokenFor(docGrantee);
    expect(html).toContain(`value="${docGranteeSpaceId}"`);
    expect(html).not.toContain(`value="${spaceId}"`);
  });

  it("refuses that space even when it is submitted directly", async () => {
    const response = await approve(docGrantee, spaceId);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("not available to this user");
  });

  it("still lets a document grantee mint a token for a space they do hold a role in", async () => {
    const code = await approvalCode(docGrantee, docGranteeSpaceId);
    const response = await exchange(code);
    expect(response.status).toBe(200);
    expect((await response.json()).permission).toBe("owner");
  });
});

describe("CLI tokens expire", () => {
  it("returns an expiry roughly 30 days out", async () => {
    const cli = await cliLogin(editor);

    const expiresAt = new Date(cli.expiresAt).getTime();
    expect(Number.isFinite(expiresAt)).toBe(true);

    const days = (expiresAt - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it("persists the expiry on the stored token", async () => {
    await cliLogin(editor);

    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/access-tokens`,
      owner.token,
    );
    expect(response.status).toBe(200);
    const { tokens } = (await response.json()) as {
      tokens: { name: string; expiresAt: string | null }[];
    };

    const cliTokens = tokens.filter((token) => token.name.startsWith("CLI ("));
    expect(cliTokens.length).toBeGreaterThan(0);
    for (const token of cliTokens) {
      expect(token.expiresAt).not.toBeNull();
    }
  });
});
