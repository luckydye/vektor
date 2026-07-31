// @ts-check

import node from "@astrojs/node";
import solid from "@astrojs/solid-js";
import vue from "@astrojs/vue";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import pkg from "./package.json";

// https://astro.build/config
export default defineConfig({
  output: "server",

  devToolbar: {
    enabled: false,
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
        path: "ko",
        codes: ["ko", "ko-KR"],
      },
    ],
  },

  integrations: [
    vue({
      appEntrypoint: "/src/app.ts",
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag.includes("-"),
        },
      },
    }),
    // Installed ahead of the port so the two renderers are proven to coexist.
    // Scoped to `.tsx` so it never tries to claim a `.vue` file; phase 6 removes
    // the Vue integration and this include can go with it.
    // `.jsx` as well as `.tsx`: @solidjs/router ships pre-compiled `.jsx` in its
    // dist, and anything the Solid plugin does not claim falls through to the
    // default JSX transform, which resolves `react/jsx-runtime` and fails the
    // build. Still scoped away from `.vue`; phase 6 removes the Vue entry.
    solid({ include: ["**/*.tsx", "**/*.jsx"] }),
  ],

  adapter: node({
    mode: "middleware",
  }),
});
