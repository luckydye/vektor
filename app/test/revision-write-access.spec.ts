/**
 * Who may *write* a document's revision history — the write-side companion to
 * `revision-access.spec.ts`. `POST /documents/:id` authorized at viewer level,
 * so `readonly` was all that stopped a viewer writing revisions (audit 014).
 *
 *   mode: "revision"    a document write, so EDITOR
 *   mode: "suggestion"  a proposal an editor applies, so the `comment` feature
 *
 * Both halves are asserted: viewers are refused the save, *and* a viewer who
 * may comment can actually suggest — which used to answer 500.
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

const PORT = 7494;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);

const PUBLISHED_CONTENT = "<p>published content, owner-authored</p>";
const VIEWER_PAYLOAD = "<p>OVERWRITTEN BY VIEWER</p>";
const VIEWER_XSS_PAYLOAD = "<p>x</p><img src=x onerror=alert(1)>";

let serverProcess: TestServerProcess;
let ownerToken: string;
/** Space-wide VIEWER — the audit 014 repro identity. */
let spaceViewer: { userId: string; token: string };
/** No space role at all; a document-level VIEWER grant only. */
let docViewer: { userId: string; token: string };
/** No grant of any kind, so the public-group share is its entire access. */
let outsider: { userId: string; token: string };
/** Space VIEWER plus an explicit `comment` feature grant. */
let commentViewer: { userId: string; token: string };
/** The `comment` feature but no role, so the suggestion gate still needs read access. */
let featureOnlyOutsider: { userId: string; token: string };
/** Space EDITOR. Holds `comment` by default via the role. */
let editor: { userId: string; token: string };

let spaceId: string;
/** Published, shared with `public` as viewer. The main fixture. */
let documentId: string;
/** Has a saved revision but was never published. */
let unpublishedDocumentId: string;
/** Created and never saved — no revisions at all. */
let revisionlessDocumentId: string;
/** `readonly: true`. */
let readonlyDocumentId: string;
let publishedRev: number;

function documentPath(id: string, suffix = ""): string {
  return `/api/v1/spaces/${spaceId}/documents/${id}${suffix}`;
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

async function createDocument(title: string): Promise<string> {
  const response = await apiRequest(`/api/v1/spaces/${spaceId}/documents`, ownerToken, {
    method: "POST",
    body: JSON.stringify({ content: PUBLISHED_CONTENT, properties: { title } }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create document (${response.status})`);
  }
  return (await response.json()).document.id;
}

/** A save as the owner, used only to build fixtures. */
async function ownerSave(id: string, html: string): Promise<number> {
  const response = await apiRequest(documentPath(id), ownerToken, {
    method: "POST",
    body: JSON.stringify({ html, mode: "revision" }),
  });
  if (!response.ok) {
    throw new Error(`Failed to save revision (${response.status})`);
  }
  return (await response.json()).revision.rev;
}

async function publish(id: string, rev: number): Promise<void> {
  const response = await apiRequest(documentPath(id), ownerToken, {
    method: "PATCH",
    body: JSON.stringify({ publishedRev: rev }),
  });
  if (!response.ok) {
    throw new Error(`Failed to publish revision ${rev} (${response.status})`);
  }
}

/** The history as the owner sees it — the audit's "is the revision real?" check. */
async function ownerRevisions(
  id: string,
): Promise<Array<{ rev: number; createdBy: string; status: string | null }>> {
  const response = await apiRequest(documentPath(id, "/revisions"), ownerToken);
  if (!response.ok) {
    throw new Error(`Failed to list revisions (${response.status})`);
  }
  return (await response.json()).revisions;
}

function save(
  id: string,
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return apiRequest(documentPath(id), token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** A refusal — and never a 500, which would be a different bug looking alike. */
async function expectRefused(response: Response): Promise<void> {
  const body = await response.text();
  expect(response.status, `unexpected status with body ${body}`).not.toBe(500);
  expect([401, 403]).toContain(response.status);
}

beforeAll(async () => {
  process.env.AUTH_SECRET ??= "revision-write-test-secret-do-not-use-in-production";
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    VEKTOR_API_ONLY: "1",
    AUTH_SECRET: process.env.AUTH_SECRET,
  });
  await waitForServer(BASE_URL);

  const owner = await createTestUser(BASE_URL, "Write Owner", "write-owner");
  ownerToken = owner.token;
  spaceViewer = await createTestUser(BASE_URL, "Space Viewer", "write-space-viewer");
  docViewer = await createTestUser(BASE_URL, "Doc Viewer", "write-doc-viewer");
  outsider = await createTestUser(BASE_URL, "Public Outsider", "write-outsider");
  commentViewer = await createTestUser(BASE_URL, "Comment Viewer", "write-commenter");
  featureOnlyOutsider = await createTestUser(BASE_URL, "Feature Only", "write-feature");
  editor = await createTestUser(BASE_URL, "Write Editor", "write-editor");

  const spaceResponse = await apiRequest("/api/v1/spaces", ownerToken, {
    method: "POST",
    body: JSON.stringify({
      name: "Revision Write Space",
      slug: `revision-write-${Date.now()}`,
    }),
  });
  if (!spaceResponse.ok) {
    throw new Error(`Failed to create space (${spaceResponse.status})`);
  }
  spaceId = (await spaceResponse.json()).space.id;

  documentId = await createDocument("Revision Write Document");
  unpublishedDocumentId = await createDocument("Never Published Document");
  revisionlessDocumentId = await createDocument("Revisionless Document");
  readonlyDocumentId = await createDocument("Readonly Document");

  // Publishing pins rev 1, so a later save cannot overwrite it in place.
  publishedRev = await ownerSave(documentId, PUBLISHED_CONTENT);
  await publish(documentId, publishedRev);
  expect(publishedRev).toBe(1);

  // Saved but never published: the shape that answered 500.
  await ownerSave(unpublishedDocumentId, PUBLISHED_CONTENT);

  await ownerSave(readonlyDocumentId, PUBLISHED_CONTENT);
  const readonlyResponse = await apiRequest(
    documentPath(readonlyDocumentId),
    ownerToken,
    {
      method: "PATCH",
      body: JSON.stringify({ readonly: true }),
    },
  );
  if (!readonlyResponse.ok) {
    throw new Error(`Failed to mark document readonly (${readonlyResponse.status})`);
  }

  // Space-wide roles.
  await grant({ type: "role", roleOrFeature: "viewer", userId: spaceViewer.userId });
  await grant({ type: "role", roleOrFeature: "viewer", userId: commentViewer.userId });
  await grant({ type: "role", roleOrFeature: "editor", userId: editor.userId });
  await grant({
    type: "feature",
    roleOrFeature: "comment",
    userId: commentViewer.userId,
  });
  // A space-wide feature with no role to stand on.
  await grant({
    type: "feature",
    roleOrFeature: "comment",
    userId: featureOnlyOutsider.userId,
  });

  // Document-scoped viewer, with no space-wide grant to fall back on.
  await grant({
    type: "role",
    roleOrFeature: "viewer",
    userId: docViewer.userId,
    resourceType: "document",
    resourceId: documentId,
  });

  // The public share that makes `outsider` a reader of this one document.
  await grant({
    type: "role",
    roleOrFeature: "viewer",
    groupId: "public",
    resourceType: "document",
    resourceId: documentId,
  });
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("full revision save requires editor", () => {
  it("refuses a space viewer", async () => {
    await expectRefused(
      await save(documentId, spaceViewer.token, {
        html: VIEWER_PAYLOAD,
        message: "viewer edit",
      }),
    );
  });

  it("refuses a space viewer who omits the mode", async () => {
    // The default is a full revision, so the default must be the editor gate.
    await expectRefused(
      await save(documentId, spaceViewer.token, { html: VIEWER_PAYLOAD }),
    );
  });

  it("refuses a space viewer posting active markup", async () => {
    await expectRefused(
      await save(documentId, spaceViewer.token, { html: VIEWER_XSS_PAYLOAD }),
    );
  });

  it("refuses a document-level viewer", async () => {
    await expectRefused(
      await save(documentId, docViewer.token, { html: VIEWER_PAYLOAD }),
    );
  });

  it("refuses a public-group caller on a published document", async () => {
    await expectRefused(await save(documentId, outsider.token, { html: VIEWER_PAYLOAD }));
  });

  it("refuses a viewer who holds the comment feature", async () => {
    // Being allowed to suggest is not being allowed to save.
    await expectRefused(
      await save(documentId, commentViewer.token, { html: VIEWER_PAYLOAD }),
    );
  });

  it("refuses a viewer sending a raw markdown body", async () => {
    // The non-JSON branch has no `mode`, so it is always a full revision.
    const response = await fetch(`${BASE_URL}${documentPath(documentId)}`, {
      method: "POST",
      headers: {
        Cookie: `vektor.session_token=${spaceViewer.token}`,
        "Content-Type": "text/markdown",
      },
      body: "# viewer markdown edit",
    });

    await expectRefused(response);
  });

  it("refuses a viewer before critiquing their payload", async () => {
    // Gated before validation, so it is no body-validation oracle.
    const response = await save(documentId, spaceViewer.token, {});

    expect(response.status).toBe(403);
  });

  it("wrote nothing to the history", async () => {
    const revisions = await ownerRevisions(documentId);

    expect(revisions.map((revision) => revision.rev)).toEqual([publishedRev]);
    for (const revision of revisions) {
      expect(revision.createdBy).not.toBe(spaceViewer.userId);
      expect(revision.createdBy).not.toBe(docViewer.userId);
      expect(revision.createdBy).not.toBe(outsider.userId);
      expect(revision.createdBy).not.toBe(commentViewer.userId);
    }
  });

  it("allows an editor", async () => {
    const response = await save(documentId, editor.token, {
      html: "<p>editor revision</p>",
      message: "editor edit",
    });

    expect(response.status).toBe(200);
    const { revision } = await response.json();
    expect(revision.rev).toBe(publishedRev + 1);
    expect(revision.createdBy).toBe(editor.userId);
    expect(revision.status).toBe(null);
  });
});

describe("suggestion mode is the low-privilege path", () => {
  it("lets a viewer with the comment feature suggest", async () => {
    const response = await save(documentId, commentViewer.token, {
      html: "<p>viewer suggestion</p>",
      message: "please consider this",
      mode: "suggestion",
    });

    expect(response.status).toBe(200);
    const { revision } = await response.json();
    expect(revision.status).toBe("open");
    expect(revision.createdBy).toBe(commentViewer.userId);
    // Based on the published revision the suggester was looking at.
    expect(revision.parentRev).toBe(publishedRev);
  });

  it("did not change what readers get", async () => {
    // A proposal leaves the published content untouched.
    const response = await apiRequest(documentPath(documentId), outsider.token);

    expect(response.status).toBe(200);
    expect((await response.json()).document.content).toBe(PUBLISHED_CONTENT);
  });

  it("refuses a viewer without the comment feature", async () => {
    await expectRefused(
      await save(documentId, spaceViewer.token, {
        html: "<p>ungated suggestion</p>",
        mode: "suggestion",
      }),
    );
  });

  it("refuses a public-group caller without the comment feature", async () => {
    await expectRefused(
      await save(documentId, outsider.token, {
        html: "<p>ungated suggestion</p>",
        mode: "suggestion",
      }),
    );
  });

  it("refuses the comment feature alone on a document the caller cannot read", async () => {
    // The feature is space-wide, and this document is shared with no one.
    await expectRefused(
      await save(unpublishedDocumentId, featureOnlyOutsider.token, {
        html: "<p>suggestion from outside</p>",
        mode: "suggestion",
      }),
    );
  });

  it("lets an editor suggest, since the role carries the comment feature", async () => {
    const response = await save(documentId, editor.token, {
      html: "<p>editor suggestion</p>",
      mode: "suggestion",
    });

    expect(response.status).toBe(200);
    expect((await response.json()).revision.status).toBe("open");
  });

  it("suggests against the latest saved revision when nothing is published", async () => {
    // Answered 500 before: createSuggestion threw with nothing published.
    const response = await save(unpublishedDocumentId, commentViewer.token, {
      html: "<p>suggestion on an unpublished document</p>",
      mode: "suggestion",
    });

    expect(response.status).toBe(200);
    const { revision } = await response.json();
    expect(revision.status).toBe("open");
    expect(revision.parentRev).toBe(1);
  });

  it("answers 400, not 500, for a document with no revision to suggest against", async () => {
    const response = await save(revisionlessDocumentId, editor.token, {
      html: "<p>suggestion with no base</p>",
      mode: "suggestion",
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("no saved revision");
  });

  it("keeps suggestions out of the published line", async () => {
    const revisions = await ownerRevisions(documentId);
    const suggestions = revisions.filter((revision) => revision.status === "open");

    expect(suggestions.length).toBe(2);
    // Nothing a suggester wrote became the published revision.
    const document = await apiRequest(documentPath(documentId), ownerToken);
    expect((await document.json()).document.publishedRev).toBe(publishedRev);
  });
});

describe("readonly outranks the role", () => {
  it("refuses an editor's full save", async () => {
    const response = await save(readonlyDocumentId, editor.token, {
      html: "<p>editing a locked document</p>",
    });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("readonly");
  });

  it("refuses an editor's suggestion", async () => {
    const response = await save(readonlyDocumentId, editor.token, {
      html: "<p>suggesting on a locked document</p>",
      mode: "suggestion",
    });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("readonly");
  });

  it("refuses a viewer, without leaking which gate stopped them first", async () => {
    await expectRefused(
      await save(readonlyDocumentId, spaceViewer.token, { html: VIEWER_PAYLOAD }),
    );
  });
});
