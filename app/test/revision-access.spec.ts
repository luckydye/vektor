/**
 * Who may read which revision of a document.
 *
 * The publish/draft boundary is the point: publishing a document exposes exactly
 * the published snapshot, so every other revision — the drafts saved after it
 * and the pre-publication history before it — must stay behind a gate.
 * `?rev=N` used to hand all of them to anyone who could read the published
 * document, the public group included (audit 043), and to bypass the
 * VIEW_HISTORY feature that `/revisions` enforces (audit 039). `/diff?rev=N`
 * had the same gap.
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
const SECRETS = ["PRE-PUBLICATION-SECRET", "UNPUBLISHED-SECRET"];

let serverProcess: TestServerProcess;
let ownerToken: string;
/** Space viewer, no VIEW_HISTORY (the role default). */
let viewerToken: string;
/** Space viewer with an explicit VIEW_HISTORY grant. */
let historyViewerToken: string;
/** Space editor. */
let editorToken: string;
let spaceId: string;
let documentId: string;
let publishedRev: number;
let oldRev: number;
let draftRev: number;

/** Anonymous — no session cookie at all. */
function anonRequest(path: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`);
}

function documentPath(query = ""): string {
  return `/api/v1/spaces/${spaceId}/documents/${documentId}${query}`;
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

async function saveRevision(html: string): Promise<number> {
  const response = await apiRequest(documentPath(), ownerToken, {
    method: "POST",
    body: JSON.stringify({ html, mode: "revision" }),
  });
  if (!response.ok) {
    throw new Error(`Failed to save revision (${response.status})`);
  }
  return (await response.json()).revision.rev;
}

async function publish(rev: number): Promise<void> {
  const response = await apiRequest(documentPath(), ownerToken, {
    method: "PATCH",
    body: JSON.stringify({ publishedRev: rev }),
  });
  if (!response.ok) {
    throw new Error(`Failed to publish revision ${rev} (${response.status})`);
  }
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

  const docResponse = await apiRequest(
    `/api/v1/spaces/${spaceId}/documents`,
    ownerToken,
    {
      method: "POST",
      body: JSON.stringify({
        content: REV1_CONTENT,
        properties: { title: "Revision Access Document" },
      }),
    },
  );
  if (!docResponse.ok) {
    throw new Error(`Failed to create document (${docResponse.status})`);
  }
  documentId = (await docResponse.json()).document.id;

  // Publishing pins a revision, so the next save cannot overwrite it in place —
  // that is what makes three distinct revisions here.
  oldRev = await saveRevision(REV1_CONTENT);
  await publish(oldRev);
  publishedRev = await saveRevision(REV2_CONTENT);
  await publish(publishedRev);
  draftRev = await saveRevision(REV3_CONTENT);
  expect([oldRev, publishedRev, draftRev]).toEqual([1, 2, 3]);

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

  it("is still refused the unpublished draft", async () => {
    await expectRefused(
      await apiRequest(documentPath(`?rev=${draftRev}`), historyViewerToken),
    );
  });

  it("is still refused the draft through the diff endpoint", async () => {
    await expectRefused(
      await apiRequest(documentPath(`/diff?rev=${draftRev}`), historyViewerToken),
    );
  });

  it("is still refused the draft as a diff base", async () => {
    await expectRefused(
      await apiRequest(
        documentPath(`/diff?rev=${publishedRev}&base=${draftRev}`),
        historyViewerToken,
      ),
    );
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
