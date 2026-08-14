import { afterEach, describe, expect, it } from "vitest";
import { canCreateSpace, spaceCreationGroups } from "#acl/spaceCreation.ts";
import { LOCAL_USER_ID } from "#noAuth";

function setAllowList(value: string | undefined) {
  if (value === undefined) {
    delete process.env.VEKTOR_SPACE_CREATION_GROUPS;
    return;
  }
  process.env.VEKTOR_SPACE_CREATION_GROUPS = value;
}

afterEach(() => {
  setAllowList(undefined);
  delete process.env.VEKTOR_NO_AUTH;
});

describe("spaceCreationGroups", () => {
  it("is unrestricted when unset or blank", () => {
    setAllowList(undefined);
    expect(spaceCreationGroups()).toBeNull();

    setAllowList("   ");
    expect(spaceCreationGroups()).toBeNull();
  });

  it("parses a comma-separated list, trimming each entry", () => {
    setAllowList("space-admins, platform.team ,eng:leads");
    expect(spaceCreationGroups()).toEqual(["space-admins", "platform.team", "eng:leads"]);
  });

  it("drops entries that are not well-formed group names", () => {
    setAllowList(`good-group,bad group,also"bad,${"x".repeat(65)},fine_1`);
    expect(spaceCreationGroups()).toEqual(["good-group", "fine_1"]);
  });

  // Every caller carries `public`, so honouring it would turn a list that reads
  // as configured into one that admits the whole instance.
  it("never honours the synthetic public group", () => {
    setAllowList("public");
    expect(spaceCreationGroups()).toEqual([]);

    setAllowList("public,admins");
    expect(spaceCreationGroups()).toEqual(["admins"]);
  });

  // A typo must not silently reopen creation to everyone.
  it("denies everyone when configured with only unusable entries", () => {
    setAllowList("bad group,another bad one");
    expect(spaceCreationGroups()).toEqual([]);
  });
});

describe("canCreateSpace", () => {
  it("allows anyone while no allow list is configured", async () => {
    setAllowList(undefined);
    await expect(canCreateSpace("user-1")).resolves.toBe(true);
  });

  it("denies everyone when the allow list names no usable group", async () => {
    setAllowList("public");
    await expect(canCreateSpace("user-1")).resolves.toBe(false);
  });

  it("keeps the local user creating in no-auth mode", async () => {
    process.env.VEKTOR_NO_AUTH = "1";
    setAllowList("space-admins");
    await expect(canCreateSpace(LOCAL_USER_ID)).resolves.toBe(true);
  });
});
