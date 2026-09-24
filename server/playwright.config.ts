import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests, for behaviour a happy-dom spec cannot reach.
 *
 * The canvas is the reason this exists. It is a light-DOM custom element that
 * measures real geometry and drives everything through pointer events, so it
 * only truly runs in a browser — and a break there is silent: the element
 * simply never upgrades and the page renders an empty box while every other
 * suite still passes.
 *
 * `run.ts` builds the client, boots a disposable in-memory server and seeds it,
 * then runs this. No screenshots, so there is nothing machine-specific and
 * nothing to re-approve.
 */
export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /.*\.e2e\.ts/,
  outputDir: "./test/e2e/.results",

  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "line" : "list",
  timeout: 60_000,

  use: {
    baseURL: process.env.VEKTOR_E2E_BASE_URL ?? "http://127.0.0.1:4398",
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    contextOptions: { reducedMotion: "reduce" },
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
