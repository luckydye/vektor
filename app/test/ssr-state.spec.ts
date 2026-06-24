import { describe, expect, it } from "bun:test";
import { useUserProfile } from "../src/composeables/useUserProfile.ts";

describe("SSR state isolation", () => {
  it("does not share user profile refs between server renders", () => {
    const firstProfile = useUserProfile();
    const secondProfile = useUserProfile();

    expect(firstProfile).not.toBe(secondProfile);
    firstProfile.value = {
      id: "first-user",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      email: "first@example.com",
      emailVerified: true,
      name: "First User",
    };
    expect(secondProfile.value).toBeUndefined();
  });
});
