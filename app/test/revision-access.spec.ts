/**
 * Who may read which revision of a document.
 *
 * Publishing exposes the published snapshot; every other revision is history,
 * which `VIEW_HISTORY` gates as one privilege. `?rev=N` and `/diff` used to hand
 * history to anyone who could read the published document, the public group
 * included (audit 043), bypassing the feature `/revisions` enforces (audit 039).
 *
 * The fixture is the 043 repro: a private space, one document shared with the
 * `public` group as viewer, and three revisions —
 *
 *   rev 1  pre-publication content, later replaced (was published, then moved on)
 *   rev 2  the published revision
 *   rev 3  an unpublished draft written after publication
 *
 * so each identity can be asked for all three.
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

const REV1_CONTENT = "<p>rev1 PRE-PUBLICATION-SECRET credential-abc</p>";
const REV2_CONTENT = "<p>rev2 PUBLISHED public-ok</p>";
const REV3_CONTENT = "<p>rev3 UNPUBLISHED-SECRET merger-price-9999</p>";
const SUGGESTION_CONTENT = "<p>SUGGESTION-SECRET rejected-counteroffer</p>";
const SECRETS = ["PRE-PUBLICATION-SECRET", "UNPUBLISHED-SECRET", "SUGGESTION-SECRET"];

let serverProcess: TestServerProcess;
let ownerToken: string;
/** Space viewer, no VIEW_HISTORY (the role default). */
let viewerToken: string;
/** Space viewer with an explicit VIEW_HISTORY grant. */
let historyViewerToken: string;
/** Space editor. */
let editorToken: string;
/** Editor on the document alone, with no role on the space at all. */
let sharedEditorToken: string;
/** Viewer on the document alone, with no role on the space at all. */
let sharedViewerToken: string;
let spaceId: string;
let documentId: string;
let publishedRev: number;
let oldRev: number;
let draftRev: number;

/** A second document: a suggestion a later publish left *below* the pointer. */
let suggestionDocumentId: string;
let suggestionRev: number;

/** A workflow run — a type this route refuses whole, by any parameter. */
let workflowRunDocumentId: string;

/** Access tokens, whose ACL identity is `token:<id>` rather than a user. */
let viewerAccessToken: string;
let editorAccessToken: string;

/** Anonymous — no session cookie at all. */
function anonRequest(path: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`);
}

function documentPath(query = ""): string {
  return `/api/v1/spaces/${spaceId}/documents/${documentId}${query}`;
}

function pathFor(id: string, query = ""): string {
  return `/api/v1/spaces/${spaceId}/documents/${id}${query}`;
}

async function grant(body: Record<string, unknown>): Promise<void> {
  const response = await apiRequest(`/api/v1/spaces/${spaceId}/permissions`, ownerToken, {
    method: "POST",
    body: JSON.stringify({ action: "grant", ...body }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to grant ${JSON.stringify(body)} (${response.status}): ${await response.text()}`,
    );
  }
}

async function saveRevision(
  html: string,
  id = documentId,
  mode: "revision" | "suggestion" = "revision",
): Promise<number> {
  const response = await apiRequest(pathFor(id), ownerToken, {
    method: "POST",
    body: JSON.stringify({ html, mode }),
  });
  if (!response.ok) {
    throw new Error(`Failed to save ${mode} (${response.status})`);
  }
  return (await response.json()).revision.rev;
}

async function publish(rev: number, id = documentId): Promise<void> {
  const response = await apiRequest(pathFor(id), ownerToken, {
    method: "PATCH",
    body: JSON.stringify({ publishedRev: rev }),
  });
  if (!response.ok) {
    throw new Error(`Failed to publish revision ${rev} (${response.status})`);
  }
}

async function createDocument(body: Record<string, unknown>): Promise<string> {
  const response = await apiRequest(`/api/v1/spaces/${spaceId}/documents`, ownerToken, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to create document (${response.status}): ${await response.text()}`,
    );
  }
  return (await response.json()).document.id;
}

function tokenRequest(path: string, token: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

async function createSpaceToken(
  name: string,
  permission: "viewer" | "editor",
): Promise<string> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/access-tokens`,
    ownerToken,
    {
      method: "POST",
      body: JSON.stringify({
        name,
        permission,
        resourceType: "space",
        resourceId: spaceId,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to create token (${response.status})`);
  }
  return (await response.json()).token;
}

/** A refusal, plus the guarantee that the refusal did not carry the content anyway. */
async function expectRefused(response: Response): Promise<void> {
  const body = await response.text();
  expect([401, 403]).toContain(response.status);
  for (const secret of SECRETS) {
    expect(body).not.toContain(secret);
  }
}

beforeAll(async () => {
  process.env.AUTH_SECRET ??= "revision-access-test-secret-do-not-use-in-production";
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    // Every request here is an API request; the Astro frontend would only add a
    // build dependency to a spec that never renders a page.
    VEKTOR_API_ONLY: "1",
    AUTH_SECRET: process.env.AUTH_SECRET,
  });
  await waitForServer(BASE_URL);

  const owner = await createTestUser(BASE_URL, "Revision Owner", "rev-owner");
  ownerToken = owner.token;
  const viewer = await createTestUser(BASE_URL, "Revision Viewer", "rev-viewer");
  viewerToken = viewer.token;
  const historyViewer = await createTestUser(BASE_URL, "History Viewer", "rev-history");
  historyViewerToken = historyViewer.token;
  const editor = await createTestUser(BASE_URL, "Revision Editor", "rev-editor");
  editorToken = editor.token;
  const sharedEditor = await createTestUser(BASE_URL, "Shared Editor", "rev-shared-ed");
  sharedEditorToken = sharedEditor.token;
  const sharedViewer = await createTestUser(BASE_URL, "Shared Viewer", "rev-shared-vw");
  sharedViewerToken = sharedViewer.token;

  const spaceResponse = await apiRequest("/api/v1/spaces", ownerToken, {
    method: "POST",
    body: JSON.stringify({
      name: "Revision Access Space",
      slug: `revision-access-${Date.now()}`,
    }),
  });
  if (!spaceResponse.ok) {
    throw new Error(`Failed to create space (${spaceResponse.status})`);
  }
  spaceId = (await spaceResponse.json()).space.id;

  documentId = await createDocument({
    content: REV1_CONTENT,
    properties: { title: "Revision Access Document" },
  });

  // Publishing pins a revision, so the next save cannot overwrite it in place —
  // that is what makes three distinct revisions here.
  oldRev = await saveRevision(REV1_CONTENT);
  await publish(oldRev);
  publishedRev = await saveRevision(REV2_CONTENT);
  await publish(publishedRev);
  draftRev = await saveRevision(REV3_CONTENT);
  expect([oldRev, publishedRev, draftRev]).toEqual([1, 2, 3]);

  suggestionDocumentId = await createDocument({
    content: REV1_CONTENT,
    properties: { title: "Suggestion Boundary Document" },
  });
  const suggestionBaseRev = await saveRevision(REV1_CONTENT, suggestionDocumentId);
  await publish(suggestionBaseRev, suggestionDocumentId);
  suggestionRev = await saveRevision(
    SUGGESTION_CONTENT,
    suggestionDocumentId,
    "suggestion",
  );
  // Publishing past the suggestion is what used to release it.
  const laterRev = await saveRevision(REV2_CONTENT, suggestionDocumentId);
  await publish(laterRev, suggestionDocumentId);
  expect(suggestionRev).toBeLessThan(laterRev);

  workflowRunDocumentId = await createDocument({
    content: REV2_CONTENT,
    type: "workflow-run",
    properties: { title: "Workflow Run" },
  });

  // The 043 repro: a private space with this one document shared publicly.
  await grant({
    type: "role",
    roleOrFeature: "viewer",
    groupId: "public",
    resourceType: "document",
    resourceId: documentId,
  });
  await grant({ type: "role", roleOrFeature: "viewer", userId: viewer.userId });
  await grant({ type: "role", roleOrFeature: "viewer", userId: historyViewer.userId });
  await grant({ type: "role", roleOrFeature: "editor", userId: editor.userId });
  await grant({
    type: "feature",
    roleOrFeature: "view_history",
    userId: historyViewer.userId,
  });

  viewerAccessToken = await createSpaceToken("rev-viewer-token", "viewer");
  editorAccessToken = await createSpaceToken("rev-editor-token", "editor");

  // Shared on the document only — no space role, which is the whole point.
  await grant({
    type: "role",
    roleOrFeature: "editor",
    userId: sharedEditor.userId,
    resourceType: "document",
    resourceId: documentId,
  });
  await grant({
    type: "role",
    roleOrFeature: "viewer",
    userId: sharedViewer.userId,
    resourceType: "document",
    resourceId: documentId,
  });
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("anonymous caller with a public-group document grant", () => {
  it("reads the published document, as the public share intends", async () => {
    const response = await anonRequest(documentPath());

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.document.content).toBe(REV2_CONTENT);
  });

  it("reads the published revision by number", async () => {
    const response = await anonRequest(documentPath(`?rev=${publishedRev}`));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.revision.rev).toBe(publishedRev);
    expect(data.revision.content).toBe(REV2_CONTENT);
  });

  it("is refused the unpublished draft written after publication", async () => {
    await expectRefused(await anonRequest(documentPath(`?rev=${draftRev}`)));
  });

  it("is refused a pre-publication revision", async () => {
    await expectRefused(await anonRequest(documentPath(`?rev=${oldRev}`)));
  });

  it("is refused the draft through the diff endpoint", async () => {
    await expectRefused(await anonRequest(documentPath(`/diff?rev=${draftRev}`)));
  });

  it("is refused an older revision through the diff endpoint", async () => {
    await expectRefused(
      await anonRequest(documentPath(`/diff?rev=${oldRev}&base=${publishedRev}`)),
    );
  });

  it("is refused the revision listing", async () => {
    await expectRefused(await anonRequest(documentPath("/revisions")));
  });
});

describe("viewer without the view history feature", () => {
  it("reads the published revision", async () => {
    const response = await apiRequest(documentPath(`?rev=${publishedRev}`), viewerToken);

    expect(response.status).toBe(200);
    expect((await response.json()).revision.content).toBe(REV2_CONTENT);
  });

  it("is refused a pre-publication revision", async () => {
    await expectRefused(await apiRequest(documentPath(`?rev=${oldRev}`), viewerToken));
  });

  it("is refused the unpublished draft", async () => {
    await expectRefused(await apiRequest(documentPath(`?rev=${draftRev}`), viewerToken));
  });

  it("is refused the revision listing", async () => {
    await expectRefused(await apiRequest(documentPath("/revisions"), viewerToken));
  });

  it("is refused an older revision through the diff endpoint", async () => {
    await expectRefused(
      await apiRequest(
        documentPath(`/diff?rev=${oldRev}&base=${publishedRev}`),
        viewerToken,
      ),
    );
  });

  it("is refused the draft through the diff endpoint", async () => {
    await expectRefused(
      await apiRequest(documentPath(`/diff?rev=${draftRev}`), viewerToken),
    );
  });
});

describe("viewer with the view history feature", () => {
  it("reads an older published revision", async () => {
    const response = await apiRequest(documentPath(`?rev=${oldRev}`), historyViewerToken);

    expect(response.status).toBe(200);
    expect((await response.json()).revision.content).toBe(REV1_CONTENT);
  });

  it("lists the revision history", async () => {
    const response = await apiRequest(documentPath("/revisions"), historyViewerToken);

    expect(response.status).toBe(200);
    expect((await response.json()).revisions.length).toBe(3);
  });

  it("diffs two published revisions", async () => {
    const response = await apiRequest(
      documentPath(`/diff?rev=${oldRev}&base=${publishedRev}&format=html`),
      historyViewerToken,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("PRE-PUBLICATION-SECRET");
  });

  it("reads the unpublished draft, which is history like any other revision", async () => {
    const response = await apiRequest(
      documentPath(`?rev=${draftRev}`),
      historyViewerToken,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).revision.content).toBe(REV3_CONTENT);
  });

  it("diffs the draft", async () => {
    const response = await apiRequest(
      documentPath(`/diff?rev=${draftRev}&format=html`),
      historyViewerToken,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("UNPUBLISHED-SECRET");
  });
});

describe("editor", () => {
  it("reads a pre-publication revision", async () => {
    const response = await apiRequest(documentPath(`?rev=${oldRev}`), editorToken);

    expect(response.status).toBe(200);
    expect((await response.json()).revision.content).toBe(REV1_CONTENT);
  });

  it("reads the unpublished draft", async () => {
    const response = await apiRequest(documentPath(`?rev=${draftRev}`), editorToken);

    expect(response.status).toBe(200);
    expect((await response.json()).revision.content).toBe(REV3_CONTENT);
  });

  it("diffs the unpublished draft against the published revision", async () => {
    const response = await apiRequest(
      documentPath(`/diff?rev=${draftRev}&format=html`),
      editorToken,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Diff-Base-Rev")).toBe(String(publishedRev));
    expect(await response.text()).toContain("UNPUBLISHED-SECRET");
  });

  it("lists the revision history", async () => {
    const response = await apiRequest(documentPath("/revisions"), editorToken);

    expect(response.status).toBe(200);
    expect((await response.json()).revisions.length).toBe(3);
  });
});

/** Who wrote the snapshot and why is history, so it travels with the feature. */
describe("revision metadata on the published snapshot", () => {
  it("is withheld from a caller without the history feature", async () => {
    const response = await anonRequest(documentPath(`?rev=${publishedRev}`));

    expect(response.status).toBe(200);
    const { revision } = await response.json();
    expect(revision.content).toBe(REV2_CONTENT);
    expect(revision.createdBy).toBeUndefined();
    expect(revision.message).toBeUndefined();
    expect(revision.checksum).toBeUndefined();
    expect(revision.parentRev).toBeUndefined();
    // Stated, not withheld: clients read `!== null` as "is a suggestion".
    expect(revision.status).toBeNull();
  });

  it("is served to a caller who holds it", async () => {
    const response = await apiRequest(
      documentPath(`?rev=${publishedRev}`),
      historyViewerToken,
    );

    expect(response.status).toBe(200);
    const { revision } = await response.json();
    expect(revision.content).toBe(REV2_CONTENT);
    expect(revision.createdBy).toBeTruthy();
  });
});

/** A suggestion is history too — the feature is what gates it, not its status. */
describe("a suggestion left below the publish pointer", () => {
  it("is readable with the history feature", async () => {
    const response = await apiRequest(
      pathFor(suggestionDocumentId, `?rev=${suggestionRev}`),
      historyViewerToken,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).revision.content).toBe(SUGGESTION_CONTENT);
  });

  it("is refused without it", async () => {
    await expectRefused(
      await apiRequest(
        pathFor(suggestionDocumentId, `?rev=${suggestionRev}`),
        viewerToken,
      ),
    );
  });
});

/** No space role at all: VIEW_HISTORY used to resolve against the space only. */
describe("a caller shared the document directly", () => {
  it("reads the unpublished draft as its editor", async () => {
    const response = await apiRequest(
      documentPath(`?rev=${draftRev}`),
      sharedEditorToken,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).revision.content).toBe(REV3_CONTENT);
  });

  it("lists the revision history as its editor", async () => {
    const response = await apiRequest(documentPath("/revisions"), sharedEditorToken);

    expect(response.status).toBe(200);
    expect((await response.json()).revisions.length).toBe(3);
  });

  it("gets no history from a viewer share, which implies no such feature", async () => {
    await expectRefused(
      await apiRequest(documentPath(`?rev=${oldRev}`), sharedViewerToken),
    );
    await expectRefused(await apiRequest(documentPath("/revisions"), sharedViewerToken));
  });

  it("still reads the published revision from a viewer share", async () => {
    const response = await apiRequest(
      documentPath(`?rev=${publishedRev}`),
      sharedViewerToken,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).revision.content).toBe(REV2_CONTENT);
  });
});

/** A token's ACL identity is `token:<id>`, so it holds no role by inheritance. */
describe("access token", () => {
  it("reads the published revision on a viewer grant", async () => {
    const response = await tokenRequest(
      documentPath(`?rev=${publishedRev}`),
      viewerAccessToken,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).revision.content).toBe(REV2_CONTENT);
  });

  it("is refused history on a viewer grant", async () => {
    await expectRefused(
      await tokenRequest(documentPath(`?rev=${oldRev}`), viewerAccessToken),
    );
  });

  it("reads the unpublished draft on an editor grant", async () => {
    const response = await tokenRequest(
      documentPath(`?rev=${draftRev}`),
      editorAccessToken,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).revision.content).toBe(REV3_CONTENT);
  });

  it("diffs the draft on an editor grant", async () => {
    const response = await tokenRequest(
      documentPath(`/diff?rev=${draftRev}&format=html`),
      editorAccessToken,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("UNPUBLISHED-SECRET");
  });
});

/** Hidden from this route whole, so the type check precedes the revision branch. */
describe("workflow run document", () => {
  it("is not found by revision number, for the owner", async () => {
    const response = await apiRequest(
      pathFor(workflowRunDocumentId, "?rev=1"),
      ownerToken,
    );

    expect(response.status).toBe(404);
    // Named the document, so the refusal happened before any revision lookup.
    expect(await response.text()).toContain("Document not found");
  });

  it("is not found plainly either", async () => {
    const response = await apiRequest(pathFor(workflowRunDocumentId), ownerToken);

    expect(response.status).toBe(404);
  });
});
