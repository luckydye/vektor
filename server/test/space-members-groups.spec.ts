import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuthDb } from "#db/client/db.ts";
import { user as userTable } from "#db/schema/auth.ts";
import {
  createSessionApiRequest,
  createTestUser as createSharedTestUser,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7533;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);
const createTestUser = (name: string) =>
  createSharedTestUser(BASE_URL, name, "test-space-members-groups");

interface Member {
  userId?: string;
  groupId?: string;
  role: string;
  user?: { id: string; name: string; email?: string };
}

async function assignUserToGroup(userId: string, groups: string[]): Promise<void> {
  const authDb = getAuthDb();
  if (!authDb) throw new Error("Auth database not available");
  await authDb
    .update(userTable)
    .set({ groups: JSON.stringify(groups) })
    .where(eq(userTable.id, userId))
    .run();
}

async function grantToGroup(
  groupId: string,
  role: string,
  resource?: { resourceType: string; resourceId: string },
): Promise<void> {
  const res = await apiRequest(`/api/v1/spaces/${spaceId}/permissions`, owner.token, {
    method: "POST",
    body: JSON.stringify({
      type: "role",
      roleOrFeature: role,
      groupId,
      action: "grant",
      ...resource,
    }),
  });
  if (!res.ok) throw new Error(`grant failed (${res.status}): ${await res.text()}`);
}

let serverProcess: TestServerProcess;
let spaceId: string;
let documentId: string;
const run = Date.now();
const spaceGroup = `space-team-${run}`;
const categoryGroup = `category-team-${run}`;
const outsideGroup = `outsiders-${run}`;

// The owner is in neither team: the members list must not be limited to the
// caller's own group.
let owner: { id: string; name: string; token: string };
let spaceGroupMember: { id: string; name: string };
let categoryGroupMember: { id: string; name: string };
let outsider: { id: string; name: string };

beforeAll(async () => {
  // A file-backed auth DB (not VEKTOR_IN_MEMORY_DB): assignUserToGroup runs in
  // this process and must write the same `user` table the server reads.
  serverProcess = startTestServer(PORT, {
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "space-members-groups-test-secret",
  });
  await waitForServer(BASE_URL, 25_000, 200);

  const o = await createTestUser("Members Owner");
  owner = { id: o.userId, name: o.name, token: o.token };
  const s = await createTestUser("Space Group Member");
  spaceGroupMember = { id: s.userId, name: s.name };
  const c = await createTestUser("Category Group Member");
  categoryGroupMember = { id: c.userId, name: c.name };
  const x = await createTestUser("Outside Group Member");
  outsider = { id: x.userId, name: x.name };

  await assignUserToGroup(spaceGroupMember.id, [spaceGroup]);
  await assignUserToGroup(categoryGroupMember.id, [categoryGroup]);
  await assignUserToGroup(outsider.id, [outsideGroup]);

  const spaceRes = await apiRequest("/api/v1/spaces", owner.token, {
    method: "POST",
    body: JSON.stringify({ name: "Members Group Space", slug: `members-groups-${run}` }),
  });
  if (!spaceRes.ok) {
    throw new Error(`space create failed (${spaceRes.status}): ${await spaceRes.text()}`);
  }
  spaceId = (await spaceRes.json()).space.id;

  const docRes = await apiRequest(`/api/v1/spaces/${spaceId}/documents`, owner.token, {
    method: "POST",
    body: JSON.stringify({
      content: "# Team page",
      properties: { title: "Team page" },
    }),
  });
  documentId = (await docRes.json()).document.id;

  await grantToGroup(spaceGroup, "editor");
  await grantToGroup(categoryGroup, "editor", {
    resourceType: "document_tree",
    resourceId: documentId,
  });
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

async function listMembers(token: string): Promise<Member[]> {
  const res = await apiRequest(`/api/v1/spaces/${spaceId}/members`, token);
  expect(res.status).toBe(200);
  return (await res.json()) as Member[];
}

describe("GET /api/v1/spaces/:spaceId/members with group grants", () => {
  it("lists everyone a space-level group grant admits", async () => {
    const ids = (await listMembers(owner.token)).map((m) => m.userId);
    expect(ids).toContain(owner.id);
    expect(ids).toContain(spaceGroupMember.id);
  });

  it("lists everyone a group grant on a page tree admits", async () => {
    const ids = (await listMembers(owner.token)).map((m) => m.userId);
    expect(ids).toContain(categoryGroupMember.id);
  });

  it("does not list a group with no grant in this space", async () => {
    const ids = (await listMembers(owner.token)).map((m) => m.userId);
    expect(ids).not.toContain(outsider.id);
  });

  it("names every member once, whichever group the caller is in", async () => {
    const members = await listMembers(owner.token);
    const named = members.filter((m) => m.userId).map((m) => m.userId);
    expect(new Set(named).size).toBe(named.length);
    for (const member of members) {
      if (member.userId) expect(member.user?.name).toBeTruthy();
    }
  });
});
