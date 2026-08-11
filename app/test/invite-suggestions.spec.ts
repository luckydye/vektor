import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuthDb } from "#db/db.ts";
import { user as userTable } from "#db/schema/auth.ts";
import {
  createSessionApiRequest,
  createTestUser as createSharedTestUser,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7491;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);
const createTestUser = (name: string) =>
  createSharedTestUser(BASE_URL, name, "test-invite-suggestions");

async function assignUserToGroup(userId: string, groups: string[]): Promise<void> {
  const authDb = getAuthDb();
  if (!authDb) throw new Error("Auth database not available");
  await authDb
    .update(userTable)
    .set({ groups: JSON.stringify(groups) })
    .where(eq(userTable.id, userId))
    .run();
}

interface Suggestion {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

let serverProcess: TestServerProcess;

// alice + bob share an engineering group; carol is in sales; dave has no groups.
let alice: { id: string; email: string; name: string; token: string };
let bob: { id: string; email: string; name: string };
let carol: { id: string; email: string; name: string };
let dave: { id: string; email: string; name: string; token: string };

beforeAll(async () => {
  // A file-backed auth DB (not VEKTOR_IN_MEMORY_DB) is required: assignUserToGroup
  // below runs in this test process and must see the same `user` table the server
  // process migrated on boot. An in-memory DB lives only inside the server child.
  serverProcess = startTestServer(PORT, {
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "invite-suggestions-test-secret",
  });
  await waitForServer(BASE_URL, 25_000, 200);

  const a = await createTestUser("Alice Engineer");
  alice = { id: a.userId, email: a.email, name: a.name, token: a.token };
  const b = await createTestUser("Bob Engineer");
  bob = { id: b.userId, email: b.email, name: b.name };
  const c = await createTestUser("Carol Sales");
  carol = { id: c.userId, email: c.email, name: c.name };
  const d = await createTestUser("Dave Nogroup");
  dave = { id: d.userId, email: d.email, name: d.name, token: d.token };

  // Group names are unique per run. This spec runs against the file-backed auth
  // DB (see above), so its users outlive the run — with fixed names, every run
  // adds another pair to the same group until the group exceeds the endpoint's
  // 20-suggestion cap and this run's bob falls outside the slice.
  const run = Date.now();
  await assignUserToGroup(alice.id, [`engineering-${run}`]);
  await assignUserToGroup(bob.id, [`engineering-${run}`, `leads-${run}`]);
  await assignUserToGroup(carol.id, [`sales-${run}`]);
  // dave stays without any groups
}, 30_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("GET /api/v1/users/suggestions", () => {
  it("suggests users who share an OAuth group and excludes the caller", async () => {
    const res = await apiRequest("/api/v1/users/suggestions", alice.token);
    expect(res.status).toBe(200);

    const suggestions = (await res.json()) as Suggestion[];
    const ids = suggestions.map((s) => s.id);

    expect(ids).toContain(bob.id);
    expect(ids).not.toContain(alice.id); // never suggest yourself
    expect(ids).not.toContain(carol.id); // different group
    expect(ids).not.toContain(dave.id); // no groups
  });

  it("includes name and email so the inviter can recognize the person", async () => {
    const res = await apiRequest("/api/v1/users/suggestions", alice.token);
    const suggestions = (await res.json()) as Suggestion[];
    const bobSuggestion = suggestions.find((s) => s.id === bob.id);

    expect(bobSuggestion?.name).toBe(bob.name);
    expect(bobSuggestion?.email).toBe(bob.email);
  });

  it("filters by the q query on name or email", async () => {
    const matchRes = await apiRequest(
      `/api/v1/users/suggestions?q=${encodeURIComponent("Bob")}`,
      alice.token,
    );
    const matched = (await matchRes.json()) as Suggestion[];
    expect(matched.map((s) => s.id)).toContain(bob.id);

    const missRes = await apiRequest(
      "/api/v1/users/suggestions?q=zzz-nobody",
      alice.token,
    );
    expect((await missRes.json()) as Suggestion[]).toHaveLength(0);
  });

  it("returns nothing for a user with no OAuth groups", async () => {
    const res = await apiRequest("/api/v1/users/suggestions", dave.token);
    expect(res.status).toBe(200);
    expect((await res.json()) as Suggestion[]).toHaveLength(0);
  });

  it("requires authentication", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/users/suggestions`);
    expect(res.status).toBe(401);
  });
});
