import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Feature, hasFeature } from "../src/db/acl.ts";
import { LOCAL_USER_ID } from "../src/noAuth.ts";
import { createSpace } from "../src/db/spaces.ts";

const DATA_DIR = "./data";

const createdSpaceIds: string[] = [];

afterAll(() => {
  delete process.env.VEKTOR_NO_AUTH;

  for (const spaceId of createdSpaceIds) {
    const spacePath = join(DATA_DIR, "spaces", `${spaceId}.db`);
    if (existsSync(spacePath)) {
      rmSync(spacePath, { force: true });
    }
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
