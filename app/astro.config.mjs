// @ts-check

import node from "@astrojs/node";
import solid from "@astrojs/solid-js";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import pkg from "./package.json";

// https://astro.build/config
export default defineConfig({
  output: "server",

  devToolbar: {
    enabled: false,
  },

  // Only the /docs pages render markdown through Astro. Code samples there are
  // presented as dark panels in both site themes, so one dark syntax theme is
  // what the panel chrome in `styles/docs.css` is built around.
  markdown: {
    shikiConfig: {
      theme: "github-dark",
      wrap: false,
    },
  },

  security: {
    checkOrigin: false,
  },

  vite: {
    plugins: [
      //
      tailwindcss(),
    ],
    build: {
      rollupOptions: {
        external: [/\.node$/],
      },
    },
    envPrefix: "VEKTOR_",
    define: {
      "import.meta.env.VEKTOR_VERSION": `"${pkg.version}"`,
    },
    server: {
      cors: {
        origin: "*",
        methods: ["GET", "POST", "PUT", "DELETE", "PROPFIND", "REPORT", "OPTIONS"],
        allowedHeaders: ["Authorization", "Content-Type", "Depth"],
        maxAge: 86400,
      },
      proxy: {
        // API routes are served by the Hono server (src/server.ts), not Astro.
        "/api": { target: "http://127.0.0.1:8080", changeOrigin: true },
        "/.well-known/caldav": { target: "http://127.0.0.1:8080", changeOrigin: true },
        // Repository URLs are `/<space>/git/...`, so there is no fixed prefix
        // to match on — a regex key is the only way to reach them. Without it
        // a clone gets this dev server's HTML and reports that the URL is not
        // a git repository.
        //
        // The lookahead keeps this away from Vite's own module paths: without
        // it `/src/git/graph.ts` reads as a repository URL, gets proxied, and
        // 404s — which breaks hydration for the whole app rather than for one
        // import.
        "^/(?!src/|node_modules/|@id/|@fs/|@vite/)[^/]+/git/": {
          target: "http://127.0.0.1:8080",
          changeOrigin: true,
        },
        "/auth": { target: "http://127.0.0.1:8080", changeOrigin: true },
        "/sync": { target: "http://127.0.0.1:8080", changeOrigin: true, ws: true },
        "/collaboration": {
          target: "http://127.0.0.1:8080",
          changeOrigin: true,
          ws: true,
        },
      },
    },
  },

  i18n: {
    defaultLocale: "en",
    locales: [
      {
        path: "de",
        codes: ["de", "de-DE", "de-AT", "de-CH", "de-LI", "de-LU"],
      },
      {
        path: "en",
        codes: ["en", "en-US", "en-GB", "en-CA", "en-AU", "en-NZ", "en-IE"],
      },
      {
        path: "es",
        codes: ["es", "es-ES", "es-MX", "es-AR", "es-CO", "es-CL", "es-PE"],
      },
      {
        path: "ja",
        codes: ["ja", "ja-JP"],
      },
      {
        path: "ko",
        codes: ["ko", "ko-KR"],
      },
    ],
  },

  integrations: [
    // `.jsx` as well as `.tsx`: @solidjs/router ships pre-compiled `.jsx` in its
    // dist, and anything the Solid plugin does not claim falls through to the
    // default JSX transform, which resolves `react/jsx-runtime` and fails the
    // build.
    solid({ include: ["**/*.tsx", "**/*.jsx"] }),
  ],

  adapter: node({
    mode: "middleware",
  }),
});
