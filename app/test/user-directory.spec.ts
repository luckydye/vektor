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
 * The user register is the one listing that hands over the email and group claim
 * of people the caller shares nothing with, so the two things worth proving are
 * that an instance admin can read it and that nobody else can.
 */

const PORT = 7531;
const BASE_URL = testBaseUrl(PORT);
const ADMIN_GROUP = "user-directory-admins";
const apiRequest = createSessionApiRequest(BASE_URL);
const createTestUser = (name: string) =>
  createSharedTestUser(BASE_URL, name, "test-user-directory");

interface RegisterEntry {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  groups: string[];
  createdAt: string;
}

let serverProcess: TestServerProcess;
let admin: { id: string; email: string; token: string };
let member: { id: string; email: string; token: string };

beforeAll(async () => {
  // A file-backed auth DB (not VEKTOR_IN_MEMORY_DB) is required: the group write
  // below runs in this test process and must reach the same `user` table the
  // server process migrated on boot.
  serverProcess = startTestServer(PORT, {
    VEKTOR_EMAIL_AUTH: "1",
    VEKTOR_ADMIN_GROUPS: ADMIN_GROUP,
    AUTH_SECRET: process.env.AUTH_SECRET ?? "user-directory-test-secret",
  });
  await waitForServer(BASE_URL, 25_000, 200);

  const a = await createTestUser("Ada Admin");
  admin = { id: a.userId, email: a.email, token: a.token };
  const m = await createTestUser("Mia Member");
  member = { id: m.userId, email: m.email, token: m.token };

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

describe("GET /api/v1/users/directory", () => {
  it("gives an instance admin every account, with the email and groups", async () => {
    const res = await apiRequest("/api/v1/users/directory", admin.token);
    expect(res.status).toBe(200);

    const entries: RegisterEntry[] = await res.json();
    const byId = new Map(entries.map((entry) => [entry.id, entry]));

    // Someone the admin shares no space with is still in the register — that is
    // what makes it a register rather than another view of their memberships.
    expect(byId.get(member.id)?.email).toBe(member.email);
    expect(byId.get(admin.id)?.groups).toContain(ADMIN_GROUP);
    // The synthetic group every caller carries is not a group anyone is in.
    expect(byId.get(member.id)?.groups).toEqual([]);
  });

  it("refuses a signed-in user who does not administer the instance", async () => {
    const res = await apiRequest("/api/v1/users/directory", member.token);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(admin.email);
  });

  it("refuses a caller with no session at all", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/users/directory`);
    expect(res.status).toBe(401);
  });
});
