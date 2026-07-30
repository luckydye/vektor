import { defineConfig, devices } from "@playwright/test";

/**
 * Tier 3: screenshot comparison against a real browser.
 *
 * **Baselines are local only and never committed** (plan section 4.4). They
 * live outside the working tree because `git clean -fdx` is exactly what
 * removes gitignored files, and these have to survive from phase 1 to phase 6.
 * Point `VEKTOR_VISUAL_BASELINES` somewhere durable; the default is
 * `~/.vektor-visual-baselines`.
 *
 * Consequences worth remembering:
 *   - This is **not** a CI gate. Nothing runs it for you — `task test:visual`
 *     before and after a DOM-affecting change is a checklist item.
 *   - Baselines do not travel between machines or developers.
 *   - The Playwright version is pinned in package.json until phase 6. A browser
 *     bump silently invalidates every baseline.
 */
const BASELINE_DIR =
  process.env.VEKTOR_VISUAL_BASELINES ?? `${process.env.HOME}/.vektor-visual-baselines`;

export default defineConfig({
  testDir: "./test/visual",
  testMatch: /.*\.visual\.ts/,
  snapshotDir: BASELINE_DIR,
  // Machine-independent by construction is impossible for pixels, so the path
  // deliberately omits the platform: one developer, one machine, one baseline.
  // It must keep {projectName} though — the two viewports render different
  // layouts, and without it they overwrite each other's baselines.
  snapshotPathTemplate: "{snapshotDir}/{testFileName}/{projectName}/{arg}{ext}",
  outputDir: "./test/visual/.results",

  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "line" : "list",
  timeout: 60_000,

  use: {
    baseURL: process.env.VEKTOR_VISUAL_BASE_URL ?? "http://127.0.0.1:4399",
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    // Not a top-level `use` option in this version; it reaches the browser
    // through newContext(). Belt and braces with the global CSS kill in
    // fixture.ts, since it is also what makes View Transitions skip.
    contextOptions: { reducedMotion: "reduce" },
  },

  expect: {
    toHaveScreenshot: {
      // Font rasterisation differs by a hair even on one machine between OS
      // updates; a handful of pixels is not a regression.
      maxDiffPixelRatio: 0.002,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },

  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // A narrow viewport, because `useIsDesktop` branches on it.
    {
      name: "narrow",
      use: { ...devices["Desktop Chrome"], viewport: { width: 640, height: 900 } },
    },
  ],
});
