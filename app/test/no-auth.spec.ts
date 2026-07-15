import { afterAll, describe, expect, it } from "bun:test";
import { Feature, hasFeature } from "#db/acl.ts";
import { createSpace, deleteSpace } from "#db/spaces.ts";
import { LOCAL_USER_ID } from "#noAuth";

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

    expect(await hasFeature(space.id, Feature.VIEW_AUDIT, LOCAL_USER_ID)).toBe(true);
    expect(await hasFeature(space.id, Feature.VIEW_HISTORY, LOCAL_USER_ID)).toBe(true);
    expect(await hasFeature(space.id, Feature.COMMENT, LOCAL_USER_ID)).toBe(true);
  });
});
