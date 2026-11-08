/**
 * Builds the web frontend into `dist/`: the browser bundle (`dist/client`, with
 * a manifest the page shell reads to find each entry's files) and the
 * server-rendering bundle (`dist/server/render.js`).
 *
 * Run as `bun ./scripts/build-web.ts`; `build.ts` embeds the result.
 */

import { build } from "vite";
import { CLIENT_ENTRY } from "../src/web/pages.ts";

await build({
  logLevel: "info",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    manifest: true,
    rollupOptions: { input: [CLIENT_ENTRY] },
  },
});

await build({
  logLevel: "info",
  build: {
    ssr: "src/web/render.tsx",
    outDir: "dist/server",
    emptyOutDir: true,
    // The browser bundle already carries `public/`.
    copyPublicDir: false,
    rollupOptions: { output: { entryFileNames: "render.js" } },
  },
});
