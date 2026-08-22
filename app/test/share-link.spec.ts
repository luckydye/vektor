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

const ONE_SECOND_IN_DAYS = 1 / 86_400;

let serverProcess: TestServerProcess;
let owner: TestUserSession;
let editor: TestUserSession;
let viewer: TestUserSession;
let spaceId: string;
let spaceSlug: string;
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
  return await apiRequest(`/api/v1/spaces/${spaceId}/shares`, session.token, {
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

  spaceSlug = `share-links-${Date.now()}`;
  const spaceResponse = await apiRequest("/api/v1/spaces", owner.token, {
    method: "POST",
    body: JSON.stringify({ name: "Share Links", slug: spaceSlug }),
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

  const published = await apiRequest(
    `/api/v1/spaces/${spaceId}/documents/${documentId}?publish=true`,
    owner.token,
    {
      method: "PUT",
      body: JSON.stringify({ content: "<p>Shared paragraph</p>" }),
    },
  );
  expect(published.status).toBe(200);

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
    const html = await response.text();
    expect(html).toContain("Shared Fixture");
    expect(html).toContain("Shared paragraph");
    expect(html).toContain("<document-view");
    expect(html).toMatch(/<document-view[^>]*\sreadonly(?:=""|\s|>)/);
    expect(html).toContain('part="content"');
    expect(html).toContain("max-w-(--document-width)");
  });

  it("keeps an in-progress draft out of the shared page", async () => {
    const saved = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
      owner.token,
      {
        method: "PUT",
        body: JSON.stringify({ content: "<p>Private in-progress draft</p>" }),
      },
    );
    expect(saved.status).toBe(200);

    const link = await createLinkPath(owner);
    const html = await (await open(link.path)).text();
    expect(html).toContain("Shared paragraph");
    expect(html).not.toContain("Private in-progress draft");
  });

  it("renders task checkboxes as disabled controls", async () => {
    const saved = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}?publish=true`,
      owner.token,
      {
        method: "PUT",
        body: JSON.stringify({
          content:
            '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>Done</p></div></li></ul>',
        }),
      },
    );
    expect(saved.status).toBe(200);

    const link = await createLinkPath(owner);
    const html = await (await open(link.path)).text();
    expect(html).toContain(
      '<input type="checkbox" checked data-document-readonly-disabled disabled>',
    );
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
      `/api/v1/spaces/${spaceId}/shares/${link.id}`,
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
    expect((await open(`/${spaceSlug}/s/share_${crypto.randomUUID()}`)).status).toBe(404);
  });
});

describe("the attachments of a shared page", () => {
  async function ownerUpload(): Promise<string> {
    const response = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/uploads?filename=note.txt&documentId=${documentId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Cookie: `vektor.session_token=${owner.token}`,
        },
        body: "ATTACHED",
      },
    );
    expect(response.status).toBe(200);
    return (await response.json()).url as string;
  }

  it("are read from the ordinary URL, by the cookie the page hands back", async () => {
    const url = await ownerUpload();
    const saved = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}?publish=true`,
      owner.token,
      { method: "PUT", body: JSON.stringify({ content: `<p><img src="${url}"></p>` }) },
    );
    expect(saved.status).toBe(200);

    const link = await createLinkPath(owner);

    expect((await fetch(`${BASE_URL}${url}`)).status).toBe(404);

    const page = await open(link.path);
    const cookie = page.headers.get("set-cookie");
    expect(cookie).toContain("vektor.share_links=");
    expect(await page.text()).toContain(url);

    const carried = { Cookie: cookie?.split(";")[0] ?? "" };
    const attachment = await fetch(`${BASE_URL}${url}`, { headers: carried });
    expect(attachment.status).toBe(200);
    expect(attachment.headers.get("Cache-Control")).toBe("private, max-age=3600");

    const range = await fetch(`${BASE_URL}${url}`, {
      headers: { ...carried, Range: "bytes=0-2" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("Cache-Control")).toBe("private, max-age=3600");

    await apiRequest(`/api/v1/spaces/${spaceId}/shares/${link.id}`, owner.token, {
      method: "DELETE",
    });
    expect((await fetch(`${BASE_URL}${url}`, { headers: carried })).status).toBe(404);
  });
});

describe("the cookie a shared page hands back", () => {
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

  async function attach(document: string): Promise<string> {
    const uploaded = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/uploads?filename=note.txt&documentId=${document}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Cookie: `vektor.session_token=${owner.token}`,
        },
        body: "ATTACHED",
      },
    );
    expect(uploaded.status).toBe(200);
    const url = (await uploaded.json()).url as string;

    const saved = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${document}?publish=true`,
      owner.token,
      { method: "PUT", body: JSON.stringify({ content: `<p><img src="${url}"></p>` }) },
    );
    expect(saved.status).toBe(200);
    return url;
  }

  it("refuses a protected link that never passed its password", async () => {
    const url = await attach(documentId);
    const link = await createLinkPath(owner, { password: "correct horse" });

    expect((await open(link.path)).status).toBe(401);
    expect((await attachment(url, `vektor.share_links=${link.id}`)).status).toBe(404);

    const cookie = await carriedCookie(link.path, basic("correct horse"));
    expect((await attachment(url, cookie)).status).toBe(200);

    const other = await createLinkPath(owner, { password: "different horse" });
    const proof = cookie.split("~")[1];
    expect(
      (await attachment(url, `vektor.share_links=${other.id}~${proof}`)).status,
    ).toBe(404);
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

    const firstCookie = await carriedCookie(first.path);
    const bothCookie = await carriedCookie(second.path, { Cookie: firstCookie });

    expect((await attachment(secondUrl, bothCookie)).status).toBe(200);
    expect((await attachment(firstUrl, bothCookie)).status).toBe(200);
  });

  it("reaches a child page's attachments through a tree link", async () => {
    const child = (
      await (
        await apiRequest(`/api/v1/spaces/${spaceId}/documents`, owner.token, {
          method: "POST",
          body: JSON.stringify({
            content: "<p>Child</p>",
            parentId: documentId,
            properties: { title: "Child Fixture" },
          }),
        })
      ).json()
    ).document.id as string;
    const childUrl = await attach(child);

    const link = await createLinkPath(owner, { resourceType: "document_tree" });
    const cookie = await carriedCookie(`${link.path}/${child}`);
    expect((await attachment(childUrl, cookie)).status).toBe(200);

    const pageOnly = await createLinkPath(owner);
    expect((await open(`${pageOnly.path}/${child}`)).status).toBe(404);
  });

  it("reaches them for a visitor who happens to be signed in elsewhere", async () => {
    const url = await attach(documentId);
    const link = await createLinkPath(owner);
    const cookie = await carriedCookie(link.path);

    const stranger = await createTestUser(BASE_URL, "Signed In Stranger", "test-share");
    const both = `${cookie}; vektor.session_token=${stranger.token}`;
    expect((await attachment(url, both)).status).toBe(200);

    expect((await attachment(url, `vektor.session_token=${stranger.token}`)).status).toBe(
      403,
    );
  });

  it("treats a malformed cookie as carrying no links", async () => {
    const url = await attach(documentId);

    for (const value of ["%", "%zz", `${(await createLinkPath(owner)).id}~%E0%A4%A`]) {
      const response = await attachment(url, `vektor.share_links=${value}`);
      expect(response.status).toBe(404);
    }
  });

  it("reaches the page's attachments and nothing else about it", async () => {
    const link = await createLinkPath(owner);
    const cookie = await carriedCookie(link.path);

    const comments = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/comments?documentId=${documentId}`,
      { headers: { Cookie: cookie } },
    );
    expect(comments.status).toBe(404);

    const document = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/documents/${documentId}`,
      { headers: { Cookie: cookie } },
    );
    expect(document.status).toBe(404);
  });
});

describe("who may manage shares", () => {
  it("serves a link only while its document has a published revision", async () => {
    const unpublishedDocument = (
      await (
        await apiRequest(`/api/v1/spaces/${spaceId}/documents`, owner.token, {
          method: "POST",
          body: JSON.stringify({
            content: "<p>Not published</p>",
            properties: { title: "Publication Boundary" },
          }),
        })
      ).json()
    ).document;

    const link = await createLinkPath(owner, {
      resourceId: unpublishedDocument.id,
      name: "Publication Boundary",
    });
    expect((await open(link.path)).status).toBe(404);

    const published = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${unpublishedDocument.id}?publish=true`,
      owner.token,
      {
        method: "PUT",
        body: JSON.stringify({ content: "<p>Published boundary</p>" }),
      },
    );
    expect(published.status).toBe(200);
    expect((await open(link.path)).status).toBe(200);

    const unpublished = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${unpublishedDocument.id}`,
      owner.token,
      { method: "PATCH", body: JSON.stringify({ publishedRev: null }) },
    );
    expect(unpublished.status).toBe(200);
    expect((await open(link.path)).status).toBe(404);
  });

  it("lets an owner list every link in the space", async () => {
    const first = await createLinkPath(owner);
    const secondDocument = (
      await (
        await apiRequest(`/api/v1/spaces/${spaceId}/documents`, owner.token, {
          method: "POST",
          body: JSON.stringify({
            content: "<p>Settings link</p>",
            properties: { title: "Settings Link Fixture" },
          }),
        })
      ).json()
    ).document;
    const publishedSecondDocument = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${secondDocument.id}?publish=true`,
      owner.token,
      {
        method: "PUT",
        body: JSON.stringify({ content: "<p>Settings link</p>" }),
      },
    );
    expect(publishedSecondDocument.status).toBe(200);
    const second = await createLinkPath(owner, {
      resourceId: secondDocument.id,
      name: "Settings Link Fixture",
    });

    const response = await apiRequest(`/api/v1/spaces/${spaceId}/shares`, owner.token);
    expect(response.status).toBe(200);
    const allLinks = (await response.json()).links as Array<{
      id: string;
      resource?: { title: string; slug: string };
    }>;
    const ids = allLinks.map((link) => link.id);
    expect(ids).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(allLinks.find((link) => link.id === second.id)?.resource).toEqual(
      expect.objectContaining({
        title: "Settings Link Fixture",
        slug: secondDocument.slug,
      }),
    );

    const documentLinks = await apiRequest(
      `/api/v1/spaces/${spaceId}/shares?documentId=${documentId}`,
      owner.token,
    );
    expect(
      (await documentLinks.json()).links.some(
        (link: { id: string }) => link.id === second.id,
      ),
    ).toBe(false);

    expect(
      (await apiRequest(`/api/v1/spaces/${spaceId}/shares`, editor.token)).status,
    ).toBe(403);
  });

  it("refuses every share operation to an editor of the page alone", async () => {
    const scoped = await createTestUser(BASE_URL, "Page Editor", "test-share-link");
    const granted = await apiRequest(
      `/api/v1/spaces/${spaceId}/permissions`,
      owner.token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: "editor",
          action: "grant",
          userId: scoped.userId,
          resourceType: "document",
          resourceId: documentId,
        }),
      },
    );
    expect(granted.status).toBe(200);

    expect((await createLink(scoped)).status).toBe(403);
    expect((await createLink(scoped, { resourceType: "document_tree" })).status).toBe(
      403,
    );

    const listed = await apiRequest(
      `/api/v1/spaces/${spaceId}/shares?documentId=${documentId}`,
      scoped.token,
    );
    expect(listed.status).toBe(403);

    const link = await createLinkPath(owner);
    const revoked = await apiRequest(
      `/api/v1/spaces/${spaceId}/shares/${link.id}`,
      scoped.token,
      { method: "DELETE" },
    );
    expect(revoked.status).toBe(403);
    expect((await open(link.path)).status).toBe(200);
  });

  it("admits an editor and refuses a viewer", async () => {
    expect((await createLink(editor)).status).toBe(201);
    expect((await createLink(viewer)).status).toBe(403);
  });

  it("admits both page scopes, and takes either back", async () => {
    expect((await createLink(owner, { resourceType: "document" })).status).toBe(201);

    const tree = await createLinkPath(owner, { resourceType: "document_tree" });
    const revoked = await apiRequest(
      `/api/v1/spaces/${spaceId}/shares/${tree.id}`,
      owner.token,
      { method: "DELETE" },
    );
    expect(revoked.status).toBe(200);
    expect((await open(tree.path)).status).toBe(404);
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
