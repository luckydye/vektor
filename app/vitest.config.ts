import { readFile } from "node:fs/promises";
import vue from "@vitejs/plugin-vue";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";
import { viteAliases } from "./test/helpers/subpathImports.ts";

/**
 * One runner for the whole suite, in two projects.
 *
 * **Run it with `bun --bun`** (`task test`, `task test:frontend`). Without the
 * flag `bunx` starts vitest on Node, and the server project then has no `Bun`
 * global — `test/helpers/server.ts` spawns with `Bun.spawn`, and a good part of
 * the suite drives a real `bun ./src/server.ts`. Vite still does module
 * resolution either way, so `vite-plugin-solid`'s browser conditions apply
 * under Bun exactly as they do under Node; this is only about the runtime the
 * tests themselves execute in.
 *
 * The two projects exist because their environments are incompatible, not for
 * tidiness: the frontend setup files install a `fetch` stub and an inert
 * `WebSocket` so component specs never touch the network, which is precisely
 * what the server specs need to do.
 */

// Vite does not understand package.json `imports`, so the `#` subpaths have to
// be restated. Shared with `server-frontend-imports.spec.ts`.
const alias = viteAliases();

/**
 * `import x from "./f.txt" with { type: "text" }`, which Bun loads natively.
 *
 * Vitest transforms modules through Vite, so Bun's loaders never see them —
 * the agent's recipe and system-prompt bodies are embedded this way and would
 * otherwise arrive as undefined and fail at import time.
 */
function textImports() {
  return {
    name: "vektor:text-imports",
    enforce: "pre",
    async load(id: string) {
      const file = id.split("?")[0];
      if (!/\.(txt|md)$/.test(file)) return null;
      // `load`, not `transform`: Vite treats these as assets and would hand
      // back a URL string before a transform hook ever saw the contents.
      return `export default ${JSON.stringify(await readFile(file, "utf8"))};`;
    },
  };
}

export default defineConfig({
  test: {
    restoreMocks: true,
    globals: false,
    projects: [
      {
        // Components, composables and anything reactive. Both renderers are
        // registered at once so the cutover is a change of which component the
        // registry returns, not a rewrite of the suite.
        plugins: [
          vue({
            template: {
              compilerOptions: {
                // Mirrors astro.config.mjs. Without it the compiler treats
                // every `<a-popover>` / `<vektor-avatar>` as an unresolved
                // component and warns on every render.
                isCustomElement: (tag) => tag.includes("-"),
              },
            },
          }),
          // Scoped to `.tsx` so it never contends with plugin-vue over a `.vue`.
          solid({ include: ["**/*.tsx"] }),
        ],
        resolve: { alias },
        test: {
          name: "frontend",
          environment: "happy-dom",
          // Order matters: env.ts installs the runtime env script and network
          // stubs that the element registrations in setup.ts depend on.
          setupFiles: ["./test/frontend/env.ts", "./test/frontend/setup.ts"],
          include: ["test/**/*.vitest.{ts,tsx}"],
          restoreMocks: true,
        },
      },
      {
        // Server, API and integration specs. Real network, no DOM, no stubs.
        plugins: [textImports()],
        resolve: { alias },
        test: {
          name: "server",
          environment: "node",
          include: ["test/**/*.spec.ts"],
          // Playwright drives its own runner; `run.ts` boots a server.
          exclude: ["test/visual/**", "**/node_modules/**"],
          restoreMocks: true,
          // Sequential, and sharing one process. These specs boot real servers
          // on fixed ports and several assert on rows they just created, so
          // running files in parallel makes them race each other rather than
          // test anything — worth 7 tests that otherwise silently skip.
          fileParallelism: false,
          isolate: false,
        },
      },
    ],
  },
});
