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

const PORT = 7524;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);

/** One second, as the API spells a duration. */
const ONE_SECOND_IN_DAYS = 1 / 86_400;

let serverProcess: TestServerProcess;
let owner: TestUserSession;
let editor: TestUserSession;
let viewer: TestUserSession;
let spaceId: string;
let documentId: string;

async function setSpaceRole(session: TestUserSession, role: string, action: string) {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/permissions`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: role,
        action,
        userId: session.userId,
      }),
    },
  );
  expect(response.status).toBe(200);
}

async function createLink(
  session: TestUserSession,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return await apiRequest(`/api/v1/spaces/${spaceId}/share-links`, session.token, {
    method: "POST",
    body: JSON.stringify({
      name: "Shared page",
      resourceType: "document",
      resourceId: documentId,
      expiresInDays: 7,
      ...body,
    }),
  });
}

async function createLinkPath(
  session: TestUserSession,
  body: Record<string, unknown> = {},
): Promise<{ id: string; path: string }> {
  const response = await createLink(session, body);
  expect(response.status).toBe(201);
  return await response.json();
}

/** An anonymous visit, the way a link is opened. */
function open(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, { headers });
}

function basic(password: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`:${password}`).toString("base64")}` };
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "share-link-test-secret",
  });
  await waitForServer(BASE_URL);

  owner = await createTestUser(BASE_URL, "Link Owner", "test-share-link");
  editor = await createTestUser(BASE_URL, "Link Editor", "test-share-link");
  viewer = await createTestUser(BASE_URL, "Link Viewer", "test-share-link");

  const spaceResponse = await apiRequest("/api/v1/spaces", owner.token, {
    method: "POST",
    body: JSON.stringify({ name: "Share Links", slug: `share-links-${Date.now()}` }),
  });
  expect(spaceResponse.status).toBe(201);
  spaceId = (await spaceResponse.json()).space.id;

  const documentResponse = await apiRequest(
    `/api/v1/spaces/${spaceId}/documents`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        content: "<p>Shared paragraph</p>",
        properties: { title: "Shared Fixture" },
      }),
    },
  );
  expect(documentResponse.status).toBe(201);
  documentId = (await documentResponse.json()).document.id;

  await setSpaceRole(editor, "editor", "grant");
  await setSpaceRole(viewer, "viewer", "grant");
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("opening a share link", () => {
  it("renders the shared page to a caller with no session", async () => {
    const link = await createLinkPath(owner);

    const response = await open(link.path);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Shared Fixture");
  });

  it("challenges for a password, and renders once it is given", async () => {
    const link = await createLinkPath(owner, { password: "correct horse" });

    const challenged = await open(link.path);
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get("WWW-Authenticate")).toContain("Basic");

    expect((await open(link.path, basic("wrong horse"))).status).toBe(401);
    expect((await open(link.path, basic("correct horse"))).status).toBe(200);
  });

  it("stops resolving once revoked", async () => {
    const link = await createLinkPath(owner);
    expect((await open(link.path)).status).toBe(200);

    const revoked = await apiRequest(
      `/api/v1/spaces/${spaceId}/share-links/${link.id}`,
      owner.token,
      { method: "DELETE" },
    );
    expect(revoked.status).toBe(200);

    expect((await open(link.path)).status).toBe(404);
  });

  it("stops resolving once expired", async () => {
    const link = await createLinkPath(owner, { expiresInDays: ONE_SECOND_IN_DAYS });
    expect((await open(link.path)).status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect((await open(link.path)).status).toBe(404);
  });

  it("answers 404 for a link that was never minted", async () => {
    expect((await open(`/s/share_${crypto.randomUUID()}`)).status).toBe(404);
  });
});

describe("the attachments of a shared page", () => {
  /** Upload as the owner and return the stored file's URL. */
  async function ownerUpload(): Promise<string> {
    const form = new FormData();
    form.set("file", new File(["ATTACHED"], "note.txt", { type: "text/plain" }));
    form.set("filename", "note.txt");
    form.set("documentId", documentId);

    const response = await fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/uploads`, {
      method: "POST",
      headers: { Cookie: `vektor.session_token=${owner.token}` },
      body: form,
    });
    expect(response.status).toBe(200);
    return (await response.json()).url as string;
  }

  it("are read from the ordinary URL, by the cookie the page hands back", async () => {
    const url = await ownerUpload();
    const saved = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
      owner.token,
      // PUT, not POST: the shared page renders the document's live content, and
      // POST only files a revision behind it.
      { method: "PUT", body: JSON.stringify({ content: `<p><img src="${url}"></p>` }) },
    );
    expect(saved.status).toBe(200);

    const link = await createLinkPath(owner);

    // Unchanged URL, and nothing but the link behind it.
    expect((await fetch(`${BASE_URL}${url}`)).status).toBe(401);

    const page = await open(link.path);
    const cookie = page.headers.get("set-cookie");
    expect(cookie).toContain("vektor.share_links=");
    expect(await page.text()).toContain(url);

    const carried = { Cookie: cookie?.split(";")[0] ?? "" };
    expect((await fetch(`${BASE_URL}${url}`, { headers: carried })).status).toBe(200);

    // And it stops with the link, not with the browser session.
    await apiRequest(`/api/v1/spaces/${spaceId}/share-links/${link.id}`, owner.token, {
      method: "DELETE",
    });
    expect((await fetch(`${BASE_URL}${url}`, { headers: carried })).status).toBe(401);
  });
});

describe("the cookie a shared page hands back", () => {
  /** The `Set-Cookie` value a page hands back, as a request header. */
  async function carriedCookie(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<string> {
    const page = await open(path, headers);
    expect(page.status).toBe(200);
    const cookie = page.headers.get("set-cookie");
    expect(cookie).toContain("vektor.share_links=");
    return cookie?.split(";")[0] ?? "";
  }

  function attachment(url: string, cookie: string): Promise<Response> {
    return fetch(`${BASE_URL}${url}`, { headers: { Cookie: cookie } });
  }

  /** Upload a file onto `document`, put it in the content, return its URL. */
  async function attach(document: string): Promise<string> {
    const form = new FormData();
    form.set("file", new File(["ATTACHED"], "note.txt", { type: "text/plain" }));
    form.set("filename", "note.txt");
    form.set("documentId", document);

    const uploaded = await fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/uploads`, {
      method: "POST",
      headers: { Cookie: `vektor.session_token=${owner.token}` },
      body: form,
    });
    expect(uploaded.status).toBe(200);
    const url = (await uploaded.json()).url as string;

    const saved = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${document}`,
      owner.token,
      { method: "PUT", body: JSON.stringify({ content: `<p><img src="${url}"></p>` }) },
    );
    expect(saved.status).toBe(200);
    return url;
  }

  it("refuses a protected link that never passed its password", async () => {
    const url = await attach(documentId);
    const link = await createLinkPath(owner, { password: "correct horse" });

    // The page challenges — but the cookie is the client's to write, so the id
    // in it must not be taken as proof anyone ever answered.
    expect((await open(link.path)).status).toBe(401);
    expect((await attachment(url, `vektor.share_links=${link.id}`)).status).toBe(401);

    // With the password given, the page hands back a cookie that does work.
    const cookie = await carriedCookie(link.path, basic("correct horse"));
    expect((await attachment(url, cookie)).status).toBe(200);

    // And that cookie is this link's alone: it does not open another one.
    const other = await createLinkPath(owner, { password: "different horse" });
    const proof = cookie.split("~")[1];
    expect(
      (await attachment(url, `vektor.share_links=${other.id}~${proof}`)).status,
    ).toBe(401);
  });

  it("resolves every link it carries, not only the newest", async () => {
    const secondDocument = (
      await (
        await apiRequest(`/api/v1/spaces/${spaceId}/documents`, owner.token, {
          method: "POST",
          body: JSON.stringify({
            content: "<p>Second</p>",
            properties: { title: "Second Fixture" },
          }),
        })
      ).json()
    ).document.id as string;

    const firstUrl = await attach(documentId);
    const secondUrl = await attach(secondDocument);

    const first = await createLinkPath(owner);
    const second = await createLinkPath(owner, { resourceId: secondDocument });

    // Both pages visited in turn, as a browser accumulates them.
    const firstCookie = await carriedCookie(first.path);
    const bothCookie = await carriedCookie(second.path, { Cookie: firstCookie });

    // The newest resolves, and so does the one it was stacked on top of.
    expect((await attachment(secondUrl, bothCookie)).status).toBe(200);
    expect((await attachment(firstUrl, bothCookie)).status).toBe(200);
  });

  it("reaches the page's attachments and nothing else about it", async () => {
    const link = await createLinkPath(owner);
    const cookie = await carriedCookie(link.path);

    // A link is a rendered page, not the application: what the page does not
    // load, the cookie does not open.
    const comments = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/comments?documentId=${documentId}`,
      { headers: { Cookie: cookie } },
    );
    expect(comments.status).toBe(401);

    const document = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/documents/${documentId}`,
      { headers: { Cookie: cookie } },
    );
    expect(document.status).toBe(401);
  });
});

describe("who may mint a link", () => {
  it("admits an editor and refuses a viewer", async () => {
    expect((await createLink(editor)).status).toBe(201);
    expect((await createLink(viewer)).status).toBe(403);
  });

  it("refuses a scope that names no page", async () => {
    const response = await createLink(owner, {
      resourceType: "space",
      resourceId: spaceId,
    });
    expect(response.status).toBe(400);
  });

  it("keeps working after its creator leaves the space", async () => {
    const link = await createLinkPath(editor);
    expect((await open(link.path)).status).toBe(200);

    await setSpaceRole(editor, "editor", "revoke");

    // A link is not a delegation of its creator, unlike an access token.
    expect((await open(link.path)).status).toBe(200);

    await setSpaceRole(editor, "editor", "grant");
  });
});

describe("a link is not an access token", () => {
  it("is refused as a bearer credential", async () => {
    const link = await createLinkPath(owner);

    const response = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/documents/${documentId}`,
      { headers: { Authorization: `Bearer ${link.id}` } },
    );
    expect(response.status).toBe(401);
  });

  it("stays out of the access-token list", async () => {
    const link = await createLinkPath(owner);

    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/access-tokens`,
      owner.token,
    );
    expect(response.status).toBe(200);
    const ids = (await response.json()).tokens.map((token: { id: string }) => token.id);
    expect(ids).not.toContain(link.id);
  });

  it("cannot be revoked through the access-token endpoint", async () => {
    const link = await createLinkPath(owner);

    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/access-tokens/${link.id}`,
      owner.token,
      { method: "PATCH" },
    );
    expect(response.status).toBe(404);

    expect((await open(link.path)).status).toBe(200);
  });
});
