import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { useUserProfile } from "#composeables/useUserProfile.ts";

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

  /**
   * A source scan, because the alternative is rendering the whole space island
   * on the server. The failure it guards is silent and was real: with only
   * `Astro.url.pathname` handed to the island, `useSearchParams()` is empty
   * during SSR, so a route parameterised by a search param alone (`/new?title=`
   * seeds a draft title) renders its default. The client router does read the
   * query, but a component that snapshots props on setup — `TitleEditor` — has
   * already taken the wrong value by then.
   */
  it("hands the space island a url that carries the query string", () => {
    const page = readFileSync(
      resolve(process.cwd(), "src/pages/[spaceSlug]/[...all].astro"),
      "utf8",
    );
    const url = page.match(/^\s*url=\{(.+)\}$/m)?.[1];

    expect(url).toBeDefined();
    expect(url).toContain("Astro.url.search");
  });
});
