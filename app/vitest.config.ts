import { readFile } from "node:fs/promises";
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
        // Components, composables and anything reactive.
        plugins: [
          // `.jsx` too: @solidjs/router ships pre-compiled `.jsx`, and what
          // the Solid plugin does not claim falls through to the default JSX
          // transform and resolves `react/jsx-runtime`.
          solid({ include: ["**/*.tsx", "**/*.jsx"] }),
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
          exclude: ["**/node_modules/**"],
          restoreMocks: true,
          // Sequential, and sharing one process. These specs boot real servers
          // on fixed ports and several assert on rows they just created, so
          // running files in parallel makes them race each other rather than
          // test anything — worth 7 tests that otherwise silently skip.
          fileParallelism: false,
          isolate: false,
          globalSetup: ["./test/helpers/dataDir.ts"],
        },
      },
    ],
  },
});
