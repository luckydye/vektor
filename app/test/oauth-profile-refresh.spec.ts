/**
 * Driven through the real provider config against a stub IdP rather than against
 * the mapping function alone: whether better-auth writes the mapped profile back
 * on a repeat login is the part that was silently wrong.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createIdpGroupSync } from "#acl/idpSync.ts";
import { sanitizeOAuthGroups } from "#acl/oauthGroups.ts";
import { createAuth } from "#auth";
import { config } from "#config";
import { createDatabase } from "#db/client/connection.ts";
import { prepareAuthDb } from "#db/client/init.ts";
import { user as userTable } from "#db/schema/auth.ts";

const PROVIDER_ID = "test-idp";
const SITE_URL = "http://localhost:8080";
const SUBJECT = "idp-subject-1";
const EMAIL = "oauth-refresh@example.com";

/** What the stub IdP currently reports for the subject. Mutated per test. */
type Profile = Record<string, unknown>;
let profile: Profile;

interface StubIdp {
  origin: string;
  stop: () => void;
  userinfoRequests: number;
  tokenRequests: number;
  /** Makes userinfo fail, standing in for an unreachable IdP. */
  failUserinfo: boolean;
  /** Invalidate the issued access token, as an IdP does when one expires. */
  expireAccessToken: () => void;
}

/**
 * A token endpoint that accepts any code or refresh token, and a userinfo
 * endpoint serving `profile` to whoever holds the newest access token. No
 * `id_token` is issued, which keeps better-auth on the userinfo path — the one a
 * self-hosted provider with a `wiki_groups` claim uses.
 */
function startStubIdp(): StubIdp {
  let issued = 0;
  let validToken = "";

  const stub: StubIdp = {
    origin: "",
    stop: () => {},
    userinfoRequests: 0,
    tokenRequests: 0,
    failUserinfo: false,
    expireAccessToken: () => {
      validToken = "";
    },
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/token") {
        stub.tokenRequests += 1;
        issued += 1;
        validToken = `stub-access-token-${issued}`;
        return Response.json({
          access_token: validToken,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "stub-refresh-token",
          scope: "openid profile email",
        });
      }
      if (pathname === "/userinfo") {
        stub.userinfoRequests += 1;
        if (stub.failUserinfo) return new Response("upstream down", { status: 503 });
        if (request.headers.get("authorization") !== `Bearer ${validToken}`) {
          return new Response("invalid token", { status: 401 });
        }
        return Response.json(profile);
      }
      return new Response("not found", { status: 404 });
    },
  });

  stub.origin = `http://127.0.0.1:${server.port}`;
  stub.stop = () => server.stop(true);
  return stub;
}

let idp: StubIdp;
let auth: ReturnType<typeof createAuth>;
let authDb: ReturnType<typeof createDatabase>;

function testConfig(overrides: Partial<ReturnType<typeof config>> = {}) {
  return {
    ...config(),
    SITE_URL,
    AUTH_SECRET: "test-secret-for-oauth-refresh-spec",
    NODE_ENV: "test",
    OAUTH_PROVIDER_ID: PROVIDER_ID,
    OAUTH_CLIENT_ID: "stub-client",
    OAUTH_CLIENT_SECRET: "stub-secret",
    OAUTH_SCOPES: "openid,profile,email",
    OAUTH_AUTHORIZATION_URL: `${idp.origin}/authorize`,
    OAUTH_TOKEN_URL: `${idp.origin}/token`,
    OAUTH_USERINFO_URL: `${idp.origin}/userinfo`,
    OAUTH_REDIRECT_URI: `${SITE_URL}/api/auth/oauth2/callback/${PROVIDER_ID}`,
    ...overrides,
  };
}

beforeAll(async () => {
  idp = startStubIdp();

  // Its own in-memory auth database: this spec writes user rows and must not
  // race the shared data/auth.db the rest of the server suite uses.
  authDb = createDatabase("file::memory:");
  await prepareAuthDb(authDb);

  auth = createAuth(testConfig(), authDb);
});

afterAll(() => {
  idp?.stop();
});

function collectCookies(response: Response): string[] {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]);
}

/**
 * Ask for the authorization URL, then hand its `state` back to the callback with
 * an arbitrary code. The stub's authorize endpoint is never visited — a browser
 * redirect is all it would contribute.
 */
async function signIn(): Promise<Response> {
  const start = await auth.handler(
    new Request(`${SITE_URL}/api/auth/sign-in/oauth2`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: SITE_URL },
      body: JSON.stringify({ providerId: PROVIDER_ID, callbackURL: "/" }),
    }),
  );
  expect(start.status).toBe(200);

  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  expect(state).toBeTruthy();

  const callback = await auth.handler(
    new Request(
      `${SITE_URL}/api/auth/oauth2/callback/${PROVIDER_ID}?code=stub-code&state=${state}`,
      { headers: { cookie: collectCookies(start).join("; ") } },
    ),
  );

  // The callback always redirects; a failure shows up as an `error` query
  // parameter on the error URL rather than a non-2xx status.
  const location = callback.headers.get("location") ?? "";
  expect(location).not.toContain("error");

  return callback;
}

async function storedUser(email = EMAIL): Promise<{
  id: string;
  name: string;
  image: string | null;
  groups: string;
}> {
  const rows = await authDb
    .select({
      id: userTable.id,
      name: userTable.name,
      image: userTable.image,
      groups: userTable.groups,
    })
    .from(userTable)
    .where(eq(userTable.email, email));
  expect(rows).toHaveLength(1);
  const row = rows[0];
  return { id: row.id, name: row.name, image: row.image, groups: row.groups ?? "[]" };
}

async function storedGroups(email = EMAIL): Promise<string[]> {
  return JSON.parse((await storedUser(email)).groups) as string[];
}

describe("OAuth profile refresh", () => {
  it("stores the mapped profile on first sign-in", async () => {
    profile = {
      sub: SUBJECT,
      email: EMAIL,
      email_verified: true,
      name: "Ada Lovelace",
      picture: "https://idp.example.com/avatars/ada-v1.png",
      wiki_groups: ["engineering", "all-staff"],
    };

    await signIn();

    const stored = await storedUser();
    expect(stored.name).toBe("Ada Lovelace");
    expect(stored.image).toBe("https://idp.example.com/avatars/ada-v1.png");
    expect(await storedGroups()).toEqual(["engineering", "all-staff"]);
  });

  it("refreshes groups and picture on a later sign-in", async () => {
    profile = {
      sub: SUBJECT,
      email: EMAIL,
      email_verified: true,
      name: "Ada Byron",
      picture: "https://idp.example.com/avatars/ada-v2.png",
      wiki_groups: ["sales", "all-staff"],
    };

    await signIn();

    const stored = await storedUser();
    expect(stored.name).toBe("Ada Byron");
    expect(stored.image).toBe("https://idp.example.com/avatars/ada-v2.png");
    // "engineering" is gone upstream, so it must be gone here.
    expect(await storedGroups()).toEqual(["sales", "all-staff"]);
  });

  it("revokes every group when the IdP reports none", async () => {
    profile = { ...profile, wiki_groups: [] };

    await signIn();

    expect(await storedGroups()).toEqual([]);
  });

  it("keeps sanitizing group names it re-writes", async () => {
    profile = {
      ...profile,
      wiki_groups: ["ops", "not a group name!", 42, "ops", "../../etc/passwd"],
    };

    await signIn();

    expect(await storedGroups()).toEqual(["ops"]);
  });

  it("leaves stored groups alone when the claim is missing entirely", async () => {
    const { wiki_groups: _dropped, ...withoutClaim } = profile;
    profile = withoutClaim;

    await signIn();

    // A scope regression upstream would otherwise strip every grant at once.
    expect(await storedGroups()).toEqual(["ops"]);
  });

  it("does not let unmapped IdP claims reach the user row", async () => {
    profile = {
      sub: SUBJECT,
      email: EMAIL,
      email_verified: true,
      name: "Ada Byron",
      picture: "https://idp.example.com/avatars/ada-v3.png",
      wiki_groups: ["ops"],
      // Claims with no column, plus one that shares a name with a real one.
      preferred_username: "ada",
      banned: true,
      role: "admin",
    };

    await signIn();

    const stored = await storedUser();
    expect(stored.image).toBe("https://idp.example.com/avatars/ada-v3.png");
    const rows = await authDb.select().from(userTable).where(eq(userTable.email, EMAIL));
    expect(Object.keys(rows[0])).not.toContain("preferred_username");
    expect(rows[0]).not.toHaveProperty("role", "admin");
  });
});

/**
 * Each test builds its own syncer, which starts with nothing cached — the same
 * position the server is in right after a restart, so the first check re-reads.
 */
describe("mid-session group sync", () => {
  const SYNC_EMAIL = "oauth-sync@example.com";
  const SYNC_SUBJECT = "idp-subject-sync";
  let userId: string;

  function syncer(overrides: Partial<ReturnType<typeof config>> = {}) {
    return createIdpGroupSync({
      auth,
      authDb,
      appConfig: testConfig(overrides),
    });
  }

  function idpProfile(groups: unknown, picture = "https://idp.example.com/sync-v1.png") {
    return {
      sub: SYNC_SUBJECT,
      email: SYNC_EMAIL,
      email_verified: true,
      name: "Grace Hopper",
      picture,
      wiki_groups: groups,
    };
  }

  beforeAll(async () => {
    profile = idpProfile(["engineering", "ops"]);
    await signIn();
    userId = (await storedUser(SYNC_EMAIL)).id;
  });

  it("picks up a group revoked at the IdP without a new sign-in", async () => {
    profile = idpProfile(["ops"]);

    await syncer().ensureFresh(userId);

    expect(await storedGroups(SYNC_EMAIL)).toEqual(["ops"]);
  });

  it("revokes the last group too", async () => {
    profile = idpProfile([]);

    await syncer().ensureFresh(userId);

    expect(await storedGroups(SYNC_EMAIL)).toEqual([]);
  });

  it("follows a changed profile picture", async () => {
    profile = idpProfile(["ops"], "https://idp.example.com/sync-v2.png");

    await syncer().ensureFresh(userId);

    expect((await storedUser(SYNC_EMAIL)).image).toBe(
      "https://idp.example.com/sync-v2.png",
    );
  });

  it("re-reads once per interval, not once per check", async () => {
    profile = idpProfile(["ops"]);
    const sync = syncer();
    const before = idp.userinfoRequests;

    await sync.ensureFresh(userId);
    await sync.ensureFresh(userId);
    await sync.ensureFresh(userId);

    expect(idp.userinfoRequests - before).toBe(1);
  });

  it("collapses concurrent checks into one round trip", async () => {
    profile = idpProfile(["ops"]);
    const sync = syncer();
    const before = idp.userinfoRequests;

    await Promise.all(Array.from({ length: 5 }, () => sync.ensureFresh(userId)));

    expect(idp.userinfoRequests - before).toBe(1);
  });

  it("mints a new access token when the IdP rejects the stored one", async () => {
    // Sessions outlive the token minted at sign-in, so re-reads past that point
    // work only if the refresh token can mint a new one.
    const refreshEmail = "oauth-sync-refresh@example.com";
    profile = {
      sub: "idp-subject-refresh",
      email: refreshEmail,
      email_verified: true,
      name: "Alan Turing",
      picture: "https://idp.example.com/turing.png",
      wiki_groups: ["engineering"],
    };
    await signIn();
    const refreshUserId = (await storedUser(refreshEmail)).id;

    profile = { ...profile, wiki_groups: ["ops"] };
    idp.expireAccessToken();
    const tokenRequestsBefore = idp.tokenRequests;

    await syncer().ensureFresh(refreshUserId);

    expect(idp.tokenRequests).toBe(tokenRequestsBefore + 1);
    expect(await storedGroups(refreshEmail)).toEqual(["ops"]);
  });

  it("keeps the stored groups when the IdP cannot be reached", async () => {
    profile = idpProfile(["ops"]);
    await syncer().ensureFresh(userId);
    idp.failUserinfo = true;

    try {
      await syncer().ensureFresh(userId);

      // An outage must not read as "this user lost every group".
      expect(await storedGroups(SYNC_EMAIL)).toEqual(["ops"]);
    } finally {
      idp.failUserinfo = false;
    }
  });

  it("retries a failed re-read once per interval, not once per check", async () => {
    const sync = syncer();
    idp.failUserinfo = true;

    try {
      const before = idp.userinfoRequests;
      await sync.ensureFresh(userId);
      await sync.ensureFresh(userId);
      await sync.ensureFresh(userId);

      // Otherwise an outage puts a failing round trip in front of every check.
      expect(idp.userinfoRequests - before).toBe(1);
    } finally {
      idp.failUserinfo = false;
    }
  });

  it("re-reads again once the interval has passed", async () => {
    profile = idpProfile(["engineering", "ops"]);
    const sync = syncer();
    await sync.ensureFresh(userId);
    profile = idpProfile(["ops"]);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 120_000);
      await sync.ensureFresh(userId);
    } finally {
      vi.useRealTimers();
    }

    expect(await storedGroups(SYNC_EMAIL)).toEqual(["ops"]);
  });

  it("never calls the IdP for a user who does not sign in through it", async () => {
    const [local] = await authDb
      .insert(userTable)
      .values({
        id: "local-user-no-idp",
        name: "Local Only",
        email: "local-only@example.com",
        emailVerified: false,
        groups: '["ops"]',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: userTable.id });
    const before = idp.userinfoRequests;

    await syncer().ensureFresh(local.id);

    expect(idp.userinfoRequests).toBe(before);
  });

  it("is off when the interval is zero", async () => {
    const sync = syncer({ OAUTH_GROUP_SYNC_INTERVAL: "0" });
    const before = idp.userinfoRequests;

    expect(sync.enabled).toBe(false);
    await sync.ensureFresh(userId);
    expect(idp.userinfoRequests).toBe(before);
  });
});

describe("client-supplied groups", () => {
  const PASSWORD = "correct-horse-battery-staple";
  let emailAuth: ReturnType<typeof createAuth>;

  beforeAll(() => {
    emailAuth = createAuth(testConfig({ EMAIL_AUTH: "1" }), authDb);
  });

  async function signUp(email: string, body: Record<string, unknown> = {}) {
    return emailAuth.handler(
      new Request(`${SITE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: SITE_URL },
        body: JSON.stringify({ name: "Attacker", email, password: PASSWORD, ...body }),
      }),
    );
  }

  it("stores no groups for a sign-up that claims a privileged one", async () => {
    const email = "signup-claiming-groups@example.com";

    const response = await signUp(email, { groups: '["eng-team","admins"]' });
    expect(response.status).toBe(200);

    expect(await storedGroups(email)).toEqual([]);
    const returned = (await response.json()) as { user?: { groups?: unknown } };
    expect(returned.user?.groups).toBe("[]");
  });

  it("stores no groups for an array-shaped claim either", async () => {
    const email = "signup-claiming-groups-array@example.com";

    expect((await signUp(email, { groups: ["eng-team"] })).status).toBe(200);

    expect(await storedGroups(email)).toEqual([]);
  });

  it("refuses a user update that carries groups", async () => {
    const email = "update-claiming-groups@example.com";
    const created = await signUp(email);
    expect(created.status).toBe(200);
    const cookie = collectCookies(created).join("; ");
    expect(cookie).toBeTruthy();

    const response = await emailAuth.handler(
      new Request(`${SITE_URL}/api/auth/update-user`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: SITE_URL, cookie },
        body: JSON.stringify({ name: "Renamed", groups: '["eng-team"]' }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await storedGroups(email)).toEqual([]);
  });

  it("leaves IdP-provisioned groups untouched when an update is refused", async () => {
    const email = "oauth-then-update@example.com";
    profile = {
      sub: "idp-subject-update",
      email,
      email_verified: true,
      name: "Katherine Johnson",
      picture: "https://idp.example.com/katherine.png",
      wiki_groups: ["engineering"],
    };
    const callback = await signIn();
    const cookie = collectCookies(callback).join("; ");
    expect(cookie).toBeTruthy();

    const response = await auth.handler(
      new Request(`${SITE_URL}/api/auth/update-user`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: SITE_URL, cookie },
        body: JSON.stringify({ groups: "[]" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await storedGroups(email)).toEqual(["engineering"]);
  });
});

describe("group claim sanitizing", () => {
  it("caps how many groups an IdP can assign", () => {
    const many = Array.from({ length: 150 }, (_, index) => `group-${index}`);
    expect(JSON.parse(sanitizeOAuthGroups(many) ?? "[]")).toHaveLength(100);
  });

  it("reads a non-array claim as no groups, and a missing one as no change", () => {
    expect(sanitizeOAuthGroups("engineering")).toBe("[]");
    expect(sanitizeOAuthGroups(undefined)).toBeUndefined();
    expect(sanitizeOAuthGroups(null)).toBeUndefined();
  });
});
