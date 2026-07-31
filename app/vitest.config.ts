import vue from "@vitejs/plugin-vue";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";
import { viteAliases } from "./test/helpers/subpathImports.ts";

/**
 * The frontend suite.
 *
 * Separate from `bun test` for one reason: `bun test` cannot compile `.vue`
 * SFCs or Solid JSX, and the whole point of these specs is that the *same* file
 * runs against Vue today and Solid after the port. Both renderers are
 * registered here at once so the cutover is a change of which component the
 * registry returns, not a rewrite of the suite.
 *
 * Anything touching frontend or framework code belongs here, wherever it lives
 * in `test/` — not only under `test/frontend/`.
 *
 * The `bun test` specs that remain are server and integration tests: they spawn
 * `bun ./src/server.ts` and drive it over HTTP. Vitest runs on Node (verified:
 * no `Bun` global in a worker), so those cannot simply move — see
 * `test/helpers/server.ts`, which spawns with `Bun.spawn`.
 *
 * The two runners are kept apart by filename: `bun test` globs `*.spec.ts` /
 * `*.test.ts`, these are `*.vitest.{ts,tsx}`.
 */
export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          // Mirrors astro.config.mjs. Without it the compiler treats every
          // `<a-popover>` / `<vektor-avatar>` as an unresolved component and
          // warns on every render.
          isCustomElement: (tag) => tag.includes("-"),
        },
      },
    }),
    // Scoped to `.tsx` so it never contends with plugin-vue over a `.vue` file.
    solid({ include: ["**/*.tsx"] }),
  ],

  // Vite does not understand package.json `imports`, so the `#` subpaths have
  // to be restated. Shared with `server-frontend-imports.spec.ts`.
  resolve: { alias: viteAliases() },

  test: {
    environment: "happy-dom",
    // Order matters: env.ts installs the runtime env script and network
    // stubs that the element registrations in setup.ts depend on.
    setupFiles: ["./test/frontend/env.ts", "./test/frontend/setup.ts"],
    include: ["test/**/*.vitest.{ts,tsx}"],
    globals: false,
    restoreMocks: true,
  },
});
