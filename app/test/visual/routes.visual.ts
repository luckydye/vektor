import { expect, MASKS, test, waitForApp, waitForCanvas } from "./fixture.ts";

/**
 * One screenshot per route, at two viewports.
 *
 * These catch what tiers 1 and 2 structurally cannot: styling, layout, and CSS
 * fallout. A tier 2 snapshot is happy with a correct DOM rendered at the wrong
 * size or with a stylesheet missing.
 *
 * The space slug and document slug come from the seed the runner installs.
 */

const SPACE = process.env.VEKTOR_VISUAL_SPACE ?? "visual";
const DOCUMENT = process.env.VEKTOR_VISUAL_DOCUMENT ?? "getting-started";
const CANVAS = process.env.VEKTOR_VISUAL_CANVAS ?? "canvas-fixture";

const ROUTES: Array<[name: string, path: string]> = [
  ["login", "/login"],
  ["space-home", `/${SPACE}`],
  ["space-search", `/${SPACE}/search`],
  ["space-settings", `/${SPACE}/settings`],
  ["document", `/${SPACE}/doc/${DOCUMENT}`],
  ["not-found", `/${SPACE}/doc/does-not-exist`],
  ["canvas", `/${SPACE}/doc/${CANVAS}`],
];

for (const [name, path] of ROUTES) {
  test(name, async ({ page }) => {
    await page.goto(path);
    await waitForApp(page);
    // The canvas paints its layers from measured geometry after hydration, so
    // the island being interactive is not yet the same as the scene being drawn.
    if (name === "canvas") await waitForCanvas(page);
    await expect(page).toHaveScreenshot(`${name}.png`, {
      fullPage: true,
      mask: MASKS.map((selector) => page.locator(selector)),
    });
  });
}
