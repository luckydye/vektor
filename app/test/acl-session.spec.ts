import { describe, expect, it } from "vitest";
import { personPrincipal } from "#acl/session.ts";
import { createId } from "#db/ids.ts";

// The one place that decides whether an identity is a person, for all four
// doors that resolve one. Every guard downstream reads a credential-shaped id
// as a credential, so admitting one here would demote a person silently.
describe("personPrincipal", () => {
  it("admits a person", () => {
    const user = { id: "SPWkchDrqfDdMPxDU2QRuoJGyPmVhCRt", email: "a@b.c" };
    expect(personPrincipal(user)).toBe(user);
  });

  it("refuses an id shaped like a credential's", () => {
    expect(personPrincipal({ id: createId("accessToken") })).toBeNull();
  });

  it("has nothing to admit without a user", () => {
    expect(personPrincipal(null)).toBeNull();
    expect(personPrincipal(undefined)).toBeNull();
  });
});
