import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { useUserProfile } from "#composeables/useUserProfile.solid.ts";

describe("SSR state isolation", () => {
  it("does not share user profile state between server renders", () => {
    // Two roots stand in for two concurrent renders. A module-level signal
    // would hand the second render the first one's user.
    const [first, disposeFirst] = createRoot((dispose) => [useUserProfile(), dispose]);
    const [second, disposeSecond] = createRoot((dispose) => [useUserProfile(), dispose]);

    expect(first).not.toBe(second);
    expect(second()).toBeUndefined();

    disposeFirst();
    disposeSecond();
  });
});
