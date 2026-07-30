/**
 * Boots a disposable server, seeds it, and runs the screenshot suite.
 *
 * Mirrors the boot-then-test pattern `task test` already uses, but with
 * `--in-memory` so the database starts empty every time — the seed is then the
 * only content, which is what makes the pixels reproducible.
 */
import { generateClientAssetsModule } from "#build";
import { startTestServer, testBaseUrl, waitForServer } from "#test/helpers/server.ts";
import { seed } from "./seed.ts";

/**
 * Screenshots must show the working tree, not whatever was last compiled.
 *
 * The server runs in production mode here (one port, no dev proxy), which
 * serves the *embedded* client manifest — and that manifest names hashed files
 * from the previous build, so a stale one fails to boot at all. Rebuilding the
 * client and regenerating the manifest is a couple of seconds and removes a
 * whole class of "why does the screenshot not match my change".
 */
async function buildClient(): Promise<void> {
  const appDir = new URL("../..", import.meta.url).pathname;
  const build = Bun.spawn(["bunx", "--bun", "astro", "build"], {
    cwd: appDir,
    stdout: "ignore",
    stderr: "inherit",
  });
  if ((await build.exited) !== 0) throw new Error("astro build failed");
  await generateClientAssetsModule();
}

const PORT = Number(process.env.VEKTOR_VISUAL_PORT ?? 4399);
const baseUrl = testBaseUrl(PORT);

if (process.env.VEKTOR_VISUAL_SKIP_BUILD !== "1") await buildClient();

const server = startTestServer(PORT, {
  VEKTOR_NO_AUTH: "1",
  VEKTOR_IN_MEMORY_DB: "1",
  VEKTOR_SITE_URL: baseUrl,
  VEKTOR_API_URL: baseUrl,
});

const stop = () => {
  try {
    server.kill();
  } catch {
    // already gone
  }
};
process.on("exit", stop);
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

await waitForServer(baseUrl, 60_000);
const seeded = await seed(baseUrl);

const playwright = Bun.spawn(
  [
    "bunx",
    "playwright",
    "test",
    "--config",
    "playwright.config.ts",
    ...Bun.argv.slice(2),
  ],
  {
    env: {
      ...process.env,
      VEKTOR_VISUAL_BASE_URL: baseUrl,
      VEKTOR_VISUAL_SPACE: seeded.slug,
      VEKTOR_VISUAL_DOCUMENT: seeded.documentSlugs[0] ?? "untitled",
    },
    stdout: "inherit",
    stderr: "inherit",
    cwd: new URL("../..", import.meta.url).pathname,
  },
);

const code = await playwright.exited;
stop();
process.exit(code);
