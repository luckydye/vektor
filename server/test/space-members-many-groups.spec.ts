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

const PORT = 7534;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);
const createTestUser = (name: string) =>
  createSharedTestUser(BASE_URL, name, "test-members-many-groups");

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

let serverProcess: TestServerProcess;
let spaceId: string;
const run = Date.now();

// The screenshot's shape: four space-wide group grants at three role levels.
const GRANTS = [
  { group: `wikitest_see_admins_${run}`, role: "owner" },
  { group: `wikitest_see_extern_${run}`, role: "viewer" },
  { group: `wikitest_see_intern_${run}`, role: "editor" },
  { group: `wikitest_see_viewer_${run}`, role: "viewer" },
];

const people: Record<string, { id: string; name: string; token: string }> = {};

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "members-many-groups-test-secret",
  });
  await waitForServer(BASE_URL, 25_000, 200);

  const creator = await createTestUser("Space Creator");

  for (const { group } of GRANTS) {
    const u = await createTestUser(`Member of ${group}`);
    people[group] = { id: u.userId, name: u.name, token: u.token };
    await assignUserToGroup(u.userId, [group]);
  }

  const spaceRes = await apiRequest("/api/v1/spaces", creator.token, {
    method: "POST",
    body: JSON.stringify({ name: "Many Groups", slug: `many-groups-${run}` }),
  });
  spaceId = (await spaceRes.json()).space.id;

  for (const { group, role } of GRANTS) {
    const res = await apiRequest(`/api/v1/spaces/${spaceId}/permissions`, creator.token, {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        roleOrFeature: role,
        groupId: group,
        action: "grant",
      }),
    });
    if (!res.ok) throw new Error(`grant ${group} failed: ${await res.text()}`);
  }
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("members of a space held by several space-wide group grants", () => {
  for (const { group, role } of GRANTS) {
    it(`a ${role} in ${group.replace(`_${run}`, "")} sees every group's people`, async () => {
      const res = await apiRequest(
        `/api/v1/spaces/${spaceId}/members`,
        people[group].token,
      );
      expect(res.status).toBe(200);
      const members = (await res.json()) as Member[];
      const ids = members.map((m) => m.userId);

      for (const other of GRANTS) {
        expect(ids).toContain(people[other.group].id);
      }
    });
  }

  it("carries a name for every listed person, and an email only for editors up", async () => {
    const asEditor = (await (
      await apiRequest(
        `/api/v1/spaces/${spaceId}/members`,
        people[`wikitest_see_intern_${run}`].token,
      )
    ).json()) as Member[];
    const asViewer = (await (
      await apiRequest(
        `/api/v1/spaces/${spaceId}/members`,
        people[`wikitest_see_viewer_${run}`].token,
      )
    ).json()) as Member[];

    for (const list of [asEditor, asViewer]) {
      for (const member of list.filter((m) => m.userId)) {
        expect(member.user?.name).toBeTruthy();
      }
    }
    expect(asEditor.some((m) => m.user?.email)).toBe(true);
    expect(asViewer.every((m) => !m.user?.email)).toBe(true);
  });
});
