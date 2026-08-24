import { afterAll, describe, expect, it } from "vitest";
import { resolveIdentity } from "#acl/identity.ts";
import { Feature, ResourceType } from "#acl/permissions.ts";
import { hasFeature, listAccessibleResources } from "#acl/store.ts";
import { LOCAL_USER_ID } from "#config";
import { createSpace, deleteSpace } from "#db/space/spaces.ts";

const createdSpaceIds: string[] = [];

afterAll(async () => {
  delete process.env.VEKTOR_NO_AUTH;

  for (const spaceId of createdSpaceIds) {
    await deleteSpace(spaceId);
  }
});

describe("No auth mode", () => {
  it("grants feature access to the local user", async () => {
    process.env.VEKTOR_NO_AUTH = "1";

    const timestamp = Date.now();
    const space = await createSpace(
      "owner-for-test",
      `No Auth ${timestamp}`,
      `no-auth-${timestamp}`,
    );
    createdSpaceIds.push(space.id);

    const local = await resolveIdentity(LOCAL_USER_ID);
    expect(await hasFeature(space.id, Feature.VIEW_AUDIT, local)).toBe(true);
    expect(await hasFeature(space.id, Feature.VIEW_HISTORY, local)).toBe(true);
    expect(await hasFeature(space.id, Feature.COMMENT, local)).toBe(true);
  });

  it("reads every resource of a space the local user did not create as accessible", async () => {
    process.env.VEKTOR_NO_AUTH = "1";

    const timestamp = Date.now();
    const space = await createSpace(
      "owner-for-test",
      `No Auth Scope ${timestamp}`,
      `no-auth-scope-${timestamp}`,
    );
    createdSpaceIds.push(space.id);

    // The local user holds no ACL row here, so an empty list would read as
    // "nothing accessible" and silently empty every search in dev.
    expect(
      await listAccessibleResources(
        space.id,
        await resolveIdentity(LOCAL_USER_ID),
        ResourceType.DOCUMENT,
      ),
    ).toBeNull();
  });
});
