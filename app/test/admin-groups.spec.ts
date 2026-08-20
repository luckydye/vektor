import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { canCreateSpace, isInstanceAdmin, userAdminGroups } from "#acl/identity.ts";
import { adminGroups } from "#acl/instanceGroups.ts";
import { LOCAL_USER_ID } from "#config";
import { getAuthDb, initializeDatabases } from "#db/client/db.ts";
import { createId } from "#db/ids.ts";
import { spaceIndex, user } from "#db/schema/auth.ts";

function setAdmins(value: string | undefined) {
  if (value === undefined) {
    delete process.env.VEKTOR_ADMIN_GROUPS;
    return;
  }
  process.env.VEKTOR_ADMIN_GROUPS = value;
}

// Every decision below resolves an identity, which reads the auth database the
// whole run shares; whichever spec runs first has to create it.
beforeAll(() => initializeDatabases());

afterEach(() => {
  setAdmins(undefined);
  delete process.env.VEKTOR_SPACE_CREATION_GROUPS;
  delete process.env.VEKTOR_NO_AUTH;
  delete process.env.VEKTOR_MAX_SPACES_PER_USER;
});

/** A signed-up account carrying `groups`, which only the IdP claim ever sets. */
async function createUserInGroups(groups: string[]): Promise<string> {
  const id = createId("user");
  const now = new Date();
  await getAuthDb()
    .insert(user)
    .values({
      id,
      name: id,
      email: `${id}@example.com`,
      groups: JSON.stringify(groups),
      createdAt: now,
      updatedAt: now,
    });
  return id;
}

/** A space this user created, as the quota counts them. */
async function recordSpaceCreatedBy(createdBy: string): Promise<void> {
  const spaceId = createId("space");
  const now = new Date();
  await getAuthDb()
    .insert(spaceIndex)
    .values({
      id: createId("database"),
      location: `memory:${spaceId}`,
      status: "active",
      spaceId,
      name: spaceId,
      slug: spaceId,
      createdBy,
      createdAt: now,
      updatedAt: now,
    });
}

describe("adminGroups", () => {
  // The opposite default to the creation allow list: an absent setting there
  // means "everyone", which here would hand the instance away.
  it("names nobody when unset or blank", () => {
    setAdmins(undefined);
    expect(adminGroups()).toEqual([]);

    setAdmins("   ");
    expect(adminGroups()).toEqual([]);
  });

  it("parses a comma-separated list, trimming each entry", () => {
    setAdmins("vektor-admins, platform.team ,eng:leads");
    expect(adminGroups()).toEqual(["vektor-admins", "platform.team", "eng:leads"]);
  });

  it("drops entries that are not well-formed group names", () => {
    setAdmins(`good-group,bad group,also"bad,${"x".repeat(65)},fine_1`);
    expect(adminGroups()).toEqual(["good-group", "fine_1"]);
  });

  it("never honours the synthetic public group", () => {
    setAdmins("public");
    expect(adminGroups()).toEqual([]);

    setAdmins("public,vektor-admins");
    expect(adminGroups()).toEqual(["vektor-admins"]);
  });
});

describe("isInstanceAdmin", () => {
  it("is nobody while no group is configured", async () => {
    setAdmins(undefined);
    await expect(isInstanceAdmin("user-1")).resolves.toBe(false);
  });

  it("refuses an absent or public principal", async () => {
    setAdmins("vektor-admins");
    await expect(isInstanceAdmin(null)).resolves.toBe(false);
    await expect(isInstanceAdmin("")).resolves.toBe(false);
  });

  // A credential's id belongs to no user, so it carries no groups and cannot
  // intersect the admin set — which is what keeps an admin's token from being a
  // skeleton key, with nothing having to recognise the id's shape.
  it("never admits an access token principal", async () => {
    setAdmins("vektor-admins");
    await expect(isInstanceAdmin(createId("accessToken"))).resolves.toBe(false);
  });

  it("admits the local user in no-auth mode", async () => {
    process.env.VEKTOR_NO_AUTH = "1";
    setAdmins("vektor-admins");
    await expect(isInstanceAdmin(LOCAL_USER_ID)).resolves.toBe(true);
  });

  // The one identity that is an admin without being named: no-auth has no
  // groups to configure, and the local account is the whole instance.
  it("admits the local user with no admin group configured", async () => {
    process.env.VEKTOR_NO_AUTH = "1";
    setAdmins(undefined);
    await expect(isInstanceAdmin(LOCAL_USER_ID)).resolves.toBe(true);
  });

  it("does not admit the local user id while auth is on", async () => {
    setAdmins("vektor-admins");
    await expect(isInstanceAdmin(LOCAL_USER_ID)).resolves.toBe(false);
  });
});

describe("userAdminGroups", () => {
  it("is empty while no group is configured", async () => {
    setAdmins(undefined);
    await expect(userAdminGroups("user-1")).resolves.toEqual([]);
  });

  // No auth database in this suite, so the user carries only `public` — which is
  // exactly what a caller outside every configured group looks like.
  it("names only the configured groups the user is in", async () => {
    setAdmins("vektor-admins,platform-team");
    await expect(userAdminGroups("user-1")).resolves.toEqual([]);
  });
});

describe("canCreateSpace with an admin group", () => {
  // Refusing them would be theatre: they can delete and re-own every space.
  it("keeps the local no-auth admin creating despite an allow list", async () => {
    process.env.VEKTOR_NO_AUTH = "1";
    process.env.VEKTOR_SPACE_CREATION_GROUPS = "space-admins";
    setAdmins("vektor-admins");
    await expect(canCreateSpace(LOCAL_USER_ID)).resolves.toBe(true);
  });

  // The cap bounds what one account can allocate; an admin already owns every
  // space that exists, so it would bound nothing.
  it("lets an admin past the per-user space cap", async () => {
    setAdmins("vektor-admins");
    process.env.VEKTOR_MAX_SPACES_PER_USER = "1";

    const admin = await createUserInGroups(["vektor-admins"]);
    const member = await createUserInGroups([]);
    await recordSpaceCreatedBy(admin);
    await recordSpaceCreatedBy(member);

    await expect(canCreateSpace(admin)).resolves.toBe(true);
    await expect(canCreateSpace(member)).resolves.toBe(false);
  });

  it("still denies a non-admin outside the allow list", async () => {
    process.env.VEKTOR_SPACE_CREATION_GROUPS = "public";
    setAdmins("vektor-admins");
    await expect(canCreateSpace("user-1")).resolves.toBe(false);
  });
});
