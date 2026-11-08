import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";
import { defineConfig } from "vite";
import pkg from "./package.json";
import { CLIENT_ENTRY } from "./src/web/pages.ts";

/**
 * The web frontend's build, shared by the dev server (`src/web/dev.ts`, which
 * runs Vite in middleware mode) and `scripts/build-web.ts` (client bundle and
 * server-rendering bundle). The API is not part of it: Hono serves that.
 */
export default defineConfig({
  appType: "custom",
  publicDir: "public",

  plugins: [
    // `.jsx` as well as `.tsx`: @solidjs/router ships pre-compiled `.jsx` in its
    // dist, and anything the Solid plugin does not claim falls through to the
    // default JSX transform, which resolves `react/jsx-runtime` and fails the
    // build. `ssr` compiles hydratable markup for the client and string output
    // for the server.
    solid({ ssr: true, include: ["**/*.tsx", "**/*.jsx"] }),
    tailwindcss(),
  ],

  build: {
    rollupOptions: {
      external: [/\.node$/],
    },
  },

  // Crawl from the browser entry up front. Left to discover dependencies as the
  // browser asks for them, the dev server re-optimizes mid-load and answers the
  // modules already requested with "Outdated Optimize Dep".
  optimizeDeps: {
    entries: [CLIENT_ENTRY],
  },

  // `@vektorapp/spreadsheet` carries the engine and Solid as peers, and both
  // hold state that only works if there is one copy: the wasm module the
  // package calls has to be the one the app booted. A linked checkout brings
  // its own node_modules, so say which packages resolve once.
  resolve: {
    dedupe: ["@ironcalc/wasm", "solid-js"],
  },

  envPrefix: "VEKTOR_",
  define: {
    "import.meta.env.VEKTOR_VERSION": `"${pkg.version}"`,
  },
});
