/**
 * The mention fan-out at the level the bug lived: rows in the outbox.
 *
 * Issue #136 — a mention inside a comment notified nobody, because the comment
 * fan-out computed its mentions from the published document instead of the
 * comment. What the mails look like is `notification-email.spec.ts`; what this
 * spec pins down is who gets queued at all.
 *
 * The space database is read from this process, so the server runs file-backed:
 * an in-memory one would live only inside the child.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { many } from "#db/client/query.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { emailNotificationOutbox } from "#db/schema/space.ts";
import { deleteSpace } from "#db/space/spaces.ts";
import {
  createSessionApiRequest,
  createTestUser,
  startTestServer,
  type TestServerProcess,
  type TestUserSession,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7498;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let author: TestUserSession;
/** Mentioned in a comment only — never a contributor, never in the thread. */
let commentReader: TestUserSession;
/** Mentioned in the document body only. */
let documentReader: TestUserSession;
let spaceId: string;
let documentId: string;

interface OutboxRow {
  kind: string;
  sourceId: string;
  recipientUserId: string;
}

async function outbox(): Promise<OutboxRow[]> {
  const store = await openSpaceStore(spaceId);
  return many(
    store.db
      .select({
        kind: emailNotificationOutbox.kind,
        sourceId: emailNotificationOutbox.sourceId,
        recipientUserId: emailNotificationOutbox.recipientUserId,
      })
      .from(emailNotificationOutbox)
      .where(eq(emailNotificationOutbox.documentId, documentId)),
  );
}

function kindsFor(rows: OutboxRow[], recipient: TestUserSession): string[] {
  return rows
    .filter((row) => row.recipientUserId === recipient.userId)
    .map((r) => r.kind);
}

function mentionMarkdown(user: TestUserSession): string {
  return `[@${user.name}](mention:${encodeURIComponent(user.email)})`;
}

function mentionHtml(user: TestUserSession): string {
  return `<user-mention email="${user.email}">@${user.name}</user-mention>`;
}

async function grantViewer(userId: string): Promise<void> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/permissions`,
    author.token,
    {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: "viewer",
        action: "grant",
        userId,
      }),
    },
  );
  expect(response.status).toBe(200);
}

async function comment(content: string, reference: string): Promise<string> {
  const response = await apiRequest(`/api/v1/spaces/${spaceId}/comments`, author.token, {
    method: "POST",
    body: JSON.stringify({ documentId, content, reference }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).comment.id;
}

async function publish(html: string): Promise<void> {
  const saved = await apiRequest(
    `/api/v1/spaces/${spaceId}/documents/${documentId}`,
    author.token,
    { method: "POST", body: JSON.stringify({ html, mode: "revision" }) },
  );
  expect(saved.status).toBe(200);
  const rev = (await saved.json()).revision.rev;

  const published = await apiRequest(
    `/api/v1/spaces/${spaceId}/documents/${documentId}`,
    author.token,
    { method: "PATCH", body: JSON.stringify({ publishedRev: rev }) },
  );
  expect(published.status).toBe(200);
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_EMAIL_AUTH: "1",
    VEKTOR_API_ONLY: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "mention-notifications-test-secret",
  });
  await waitForServer(BASE_URL, 25_000, 200);

  author = await createTestUser(BASE_URL, "Ada Author", "mention-author");
  commentReader = await createTestUser(BASE_URL, "Bob Reader", "mention-comment");
  documentReader = await createTestUser(BASE_URL, "Grace Reader", "mention-doc");

  const spaceResponse = await apiRequest("/api/v1/spaces", author.token, {
    method: "POST",
    body: JSON.stringify({
      name: "Mention Notifications",
      slug: `mention-notifications-${Date.now()}`,
    }),
  });
  expect(spaceResponse.status).toBe(201);
  spaceId = (await spaceResponse.json()).space.id;

  await grantViewer(commentReader.userId);
  await grantViewer(documentReader.userId);

  const documentResponse = await apiRequest(
    `/api/v1/spaces/${spaceId}/documents`,
    author.token,
    {
      method: "POST",
      body: JSON.stringify({
        content: "<p>Locale handling</p>",
        properties: { title: "Locale handling" },
      }),
    },
  );
  expect(documentResponse.status).toBe(201);
  documentId = (await documentResponse.json()).document.id;
}, 60_000);

afterAll(async () => {
  serverProcess?.kill();
  if (spaceId) await deleteSpace(spaceId);
});

describe("Mention notifications", () => {
  it("queues a mention for someone the comment names and nothing else", async () => {
    const commentId = await comment(
      `Can you take a look, ${mentionMarkdown(commentReader)}?`,
      "block-1",
    );

    const rows = (await outbox()).filter((row) => row.sourceId === commentId);

    expect(kindsFor(rows, commentReader)).toEqual(["comment_mention"]);
    // The author caused the event, so nothing is queued back to them.
    expect(kindsFor(rows, author)).toEqual([]);
  });

  it("announces a document mention once, on the publish that introduced it", async () => {
    await publish(
      `<p>The locale is request-scoped.</p><p>Owner: ${mentionHtml(documentReader)} signs off.</p>`,
    );

    expect(kindsFor(await outbox(), documentReader)).toEqual(["document_mention"]);

    // The same mention, carried into a second publish, is not news again.
    await publish(
      `<p>The locale is request-scoped, finally.</p><p>Owner: ${mentionHtml(documentReader)} signs off.</p>`,
    );

    expect(kindsFor(await outbox(), documentReader)).toEqual([
      "document_mention",
      "document_published",
    ]);
  });

  it("keeps a document mention out of the fan-out for unrelated comments", async () => {
    const commentId = await comment("No mention in this one.", "block-2");

    const rows = (await outbox()).filter((row) => row.sourceId === commentId);

    expect(kindsFor(rows, documentReader)).toEqual([]);
  });
});
