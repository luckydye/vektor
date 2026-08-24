/**
 * When a space grant becomes an invitation email, at the level it is decided:
 * `space_invitation` rows in the outbox. What the mail looks like is
 * `notification-email.spec.ts`.
 *
 * The space database is read from this process, so the server runs file-backed:
 * an in-memory one would live only inside the child.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { many } from "#db/client/query.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { emailNotificationOutbox } from "#db/schema/space.ts";
import { deleteDocument } from "#db/space/documents.ts";
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

const PORT = 7501;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let owner: TestUserSession;
let invitee: TestUserSession;
let promoted: TestUserSession;
let documentId: string;
let spaceId: string;

/** The roles this recipient has been invited with, oldest first. */
async function invitations(recipientUserId: string): Promise<(string | null)[]> {
  const store = await openSpaceStore(spaceId);
  const rows = await many(
    store.db
      .select({
        kind: emailNotificationOutbox.kind,
        role: emailNotificationOutbox.role,
        recipientUserId: emailNotificationOutbox.recipientUserId,
      })
      .from(emailNotificationOutbox)
      .where(eq(emailNotificationOutbox.kind, "space_invitation")),
  );
  return rows.filter((row) => row.recipientUserId === recipientUserId).map((r) => r.role);
}

function outboxRow(id: string, recipientUserId: string) {
  const now = new Date();
  return {
    id,
    kind: "document_published",
    sourceId: id,
    documentId,
    actorId: owner.userId,
    recipientUserId,
    attempts: 0,
    availableAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

async function writeRole(
  role: string,
  userId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/permissions`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: role,
        action: "grant",
        userId,
        ...extra,
      }),
    },
  );
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_EMAIL_AUTH: "1",
    VEKTOR_API_ONLY: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "space-invitation-test-secret",
  });
  await waitForServer(BASE_URL, 25_000, 200);

  owner = await createTestUser(BASE_URL, "Ada Owner", "invite-owner");
  invitee = await createTestUser(BASE_URL, "Bob Invitee", "invite-invitee");
  promoted = await createTestUser(BASE_URL, "Grace Promoted", "invite-promoted");

  const spaceResponse = await apiRequest("/api/v1/spaces", owner.token, {
    method: "POST",
    body: JSON.stringify({
      name: "Space Invitations",
      slug: `space-invitations-${Date.now()}`,
    }),
  });
  expect(spaceResponse.status).toBe(201);
  spaceId = (await spaceResponse.json()).space.id;

  const documentResponse = await apiRequest(
    `/api/v1/spaces/${spaceId}/documents`,
    owner.token,
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

describe("Space invitation notifications", () => {
  it("queues one invitation for a first grant on the space", async () => {
    await writeRole("viewer", invitee.userId);

    expect(await invitations(invitee.userId)).toEqual(["viewer"]);
  });

  it("stays quiet when an existing member's role changes", async () => {
    await writeRole("viewer", promoted.userId);
    await writeRole("editor", promoted.userId);

    expect(await invitations(promoted.userId)).toEqual(["viewer"]);
  });

  it("does not announce the space over a share of one document in it", async () => {
    const shared = await createTestUser(BASE_URL, "Dana Shared", "invite-doc-share");
    await writeRole("viewer", shared.userId, {
      resourceType: "document",
      resourceId: documentId,
    });

    expect(await invitations(shared.userId)).toEqual([]);
  });

  it("invites again when a removed member is let back in", async () => {
    const churned = await createTestUser(BASE_URL, "Eve Churned", "invite-churned");
    await writeRole("viewer", churned.userId);
    await writeRole("viewer", churned.userId, { action: "revoke" });
    await writeRole("editor", churned.userId);

    expect(await invitations(churned.userId)).toEqual(["viewer", "editor"]);
  });

  it("never invites the owner to their own space", async () => {
    expect(await invitations(owner.userId)).toEqual([]);
  });

  it("cancels a deleted document's undelivered mail instead of removing it", async () => {
    const store = await openSpaceStore(spaceId);
    const doomed = await createTestUser(BASE_URL, "Frank Doomed", "invite-doomed");
    await store.db.insert(emailNotificationOutbox).values([
      { ...outboxRow("queued", doomed.userId), status: "pending" },
      { ...outboxRow("delivered", doomed.userId), status: "sent" },
    ]);

    await deleteDocument(store, documentId);

    const rows = await many(
      store.db
        .select({
          id: emailNotificationOutbox.id,
          status: emailNotificationOutbox.status,
        })
        .from(emailNotificationOutbox)
        .where(eq(emailNotificationOutbox.documentId, documentId)),
    );

    // Append-only: what went out stays on the record, what had not is stopped.
    expect(rows.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "delivered", status: "sent" },
      { id: "queued", status: "cancelled" },
    ]);
  });
});
