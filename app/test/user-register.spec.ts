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

/**
 * `GET /api/v1/users` unscoped: the register, which hands over the email and
 * group claim of people the caller shares nothing with. The route's scoped forms
 * are covered by the access matrix, which pins them to `?spaceId=` — so this is
 * the spec for the form that matrix cannot reach, and what it proves is that an
 * instance admin reads the register, that the empty list everyone else gets is
 * empty of other people rather than merely status-checked, and that the route
 * says which questions it will not answer instead of answering another one.
 */

const PORT = 7531;
const BASE_URL = testBaseUrl(PORT);
const ADMIN_GROUP = "user-register-admins";
const apiRequest = createSessionApiRequest(BASE_URL);
const createTestUser = (name: string) =>
  createSharedTestUser(BASE_URL, name, "test-user-register");

interface RegisterEntry {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  groups: string[];
  createdAt: string;
}

interface RegisterPage {
  users: RegisterEntry[];
  limit: number;
  nextCursor: string | null;
}

let serverProcess: TestServerProcess;
let admin: { id: string; email: string; token: string };
let member: { id: string; email: string; token: string };
let memberSpaceId: string;

beforeAll(async () => {
  // A file-backed auth DB (not VEKTOR_IN_MEMORY_DB) is required: the group write
  // below runs in this test process and must reach the same `user` table the
  // server process migrated on boot.
  serverProcess = startTestServer(PORT, {
    VEKTOR_EMAIL_AUTH: "1",
    VEKTOR_ADMIN_GROUPS: ADMIN_GROUP,
    AUTH_SECRET: process.env.AUTH_SECRET ?? "user-register-test-secret",
  });
  await waitForServer(BASE_URL, 25_000, 200);

  const a = await createTestUser("Ada Admin");
  admin = { id: a.userId, email: a.email, token: a.token };
  const m = await createTestUser("Mia Member");
  member = { id: m.userId, email: m.email, token: m.token };

  const space = await apiRequest("/api/v1/spaces", member.token, {
    method: "POST",
    body: JSON.stringify({
      name: "Register Spec Space",
      slug: `register-spec-${Date.now()}`,
    }),
  });
  memberSpaceId = (await space.json()).space.id;

  const authDb = getAuthDb();
  if (!authDb) throw new Error("Auth database not available");
  await authDb
    .update(userTable)
    .set({ groups: JSON.stringify([ADMIN_GROUP]) })
    .where(eq(userTable.id, admin.id))
    .run();
}, 30_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("GET /api/v1/users (unscoped: the register)", () => {
  it("gives an instance admin every account, with the email and groups", async () => {
    const res = await apiRequest("/api/v1/users", admin.token);
    expect(res.status).toBe(200);

    const page: RegisterPage = await res.json();
    const byId = new Map(page.users.map((entry) => [entry.id, entry]));

    // Someone the admin shares no space with is still in the register — that is
    // what makes it a register rather than another view of their memberships.
    expect(byId.get(member.id)?.email).toBe(member.email);
    expect(byId.get(admin.id)?.groups).toContain(ADMIN_GROUP);
    // The synthetic group every caller carries is not a group anyone is in.
    expect(byId.get(member.id)?.groups).toEqual([]);
  });

  // Empty rather than refused, like `/spaces` and `/search`. The assertion that
  // matters is not the status but the body: an empty list is only correct if it
  // is actually empty of other people.
  it("answers a signed-in non-admin with an empty register", async () => {
    const res = await apiRequest("/api/v1/users", member.token);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ users: [], limit: 50, nextCursor: null });
    expect(body).not.toContain(admin.email);
    expect(body).not.toContain(member.email);
  });

  // The register is bounded like every other listing here, so an instance with
  // ten thousand accounts cannot be asked for all of them in one request. What
  // the cursor has to prove is that walking it visits each account once.
  it("walks the register a page at a time, without repeating or skipping a row", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    // Bounded by the rows walked rather than by a page count: the guard is
    // against a cursor that never ends, not against how many accounts exist.
    while (seen.length <= 20_000) {
      const query = cursor
        ? `?limit=500&cursor=${encodeURIComponent(cursor)}`
        : "?limit=500";
      const res = await apiRequest(`/api/v1/users${query}`, admin.token);
      expect(res.status).toBe(200);

      const body: RegisterPage = await res.json();
      expect(body.limit).toBe(500);
      expect(body.users.length).toBeLessThanOrEqual(500);
      for (const entry of body.users) seen.push(entry.id);

      cursor = body.nextCursor;
      if (!cursor) break;
    }

    // No cursor left means the walk reached the end rather than the bound.
    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(seen.length);
    // Both accounts this spec created are somewhere in that walk, so the pages
    // together are the register and not a prefix of it.
    expect(seen).toContain(admin.id);
    expect(seen).toContain(member.id);
  });

  // A page of one is the size a seek cursor gets wrong, since every request has
  // to resume exactly where the last one stopped.
  it("hands out the same rows one at a time as it does in a single page", async () => {
    const stepped: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 5; page++) {
      const query = cursor ? `?limit=1&cursor=${encodeURIComponent(cursor)}` : "?limit=1";
      const res = await apiRequest(`/api/v1/users${query}`, admin.token);
      expect(res.status).toBe(200);

      const body: RegisterPage = await res.json();
      expect(body.limit).toBe(1);
      for (const entry of body.users) stepped.push(entry.id);

      cursor = body.nextCursor;
      if (!cursor) break;
    }

    const res = await apiRequest(`/api/v1/users?limit=${stepped.length}`, admin.token);
    const page: RegisterPage = await res.json();
    // Same rows in the same order, however they were asked for.
    expect(stepped).toEqual(page.users.map((entry) => entry.id));
  });

  // A cursor is opaque and machine-made, so an undecodable one reads as the first
  // page — the same as everywhere else here — rather than as a 400.
  it("reads an unusable cursor as the first page", async () => {
    const first: RegisterPage = await (
      await apiRequest("/api/v1/users?limit=1", admin.token)
    ).json();
    const res = await apiRequest(
      "/api/v1/users?limit=1&cursor=not-a-cursor",
      admin.token,
    );
    expect(res.status).toBe(200);

    const body: RegisterPage = await res.json();
    expect(body.users[0]?.id).toBe(first.users[0]?.id);
  });

  it("refuses a page size it cannot answer", async () => {
    for (const query of ["?limit=0", "?limit=501", "?limit=all"]) {
      const res = await apiRequest(`/api/v1/users${query}`, admin.token);
      expect(res.status).toBe(400);
    }
  });

  // A misspelled scope must not read as the register: `?userId=` used to be a 400
  // and would otherwise be answered with every account, or with an empty list a
  // client draws as an instance with nobody in it.
  it("names an unknown parameter instead of answering a different question", async () => {
    for (const token of [admin.token, member.token]) {
      const res = await apiRequest("/api/v1/users?userId=someone", token);
      expect(res.status).toBe(400);
    }
  });

  // An empty scope is the same mistake with the right spelling.
  it("refuses a scope with nothing in it", async () => {
    for (const query of ["?id=", "?spaceId=", "?id=%20"]) {
      const res = await apiRequest(`/api/v1/users${query}`, admin.token);
      expect(res.status).toBe(400);
    }
  });

  // Paging belongs to the unscoped form; the scoped ones answer one profile or one
  // space's members, so honouring neither and ignoring it silently is not an option.
  it("refuses a page on a scoped form", async () => {
    const res = await apiRequest(
      `/api/v1/users?spaceId=${memberSpaceId}&limit=1`,
      member.token,
    );
    expect(res.status).toBe(400);
  });

  it("refuses a caller with no session at all", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/users`);
    expect(res.status).toBe(401);
  });

  // The scoped form is what every signed-in account may ask, and folding the
  // register into the same route must not have widened it.
  it("still answers the space-scoped form with no email in it", async () => {
    const res = await apiRequest(`/api/v1/users?spaceId=${memberSpaceId}`, member.token);
    expect(res.status).toBe(200);

    const members = await res.json();
    expect(members.length).toBeGreaterThan(0);
    expect(members[0]).toHaveProperty("name");
    for (const profile of members) {
      expect(profile).not.toHaveProperty("email");
      expect(profile).not.toHaveProperty("groups");
    }
  });
});
