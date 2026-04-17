// @ts-check

import node from "@astrojs/node";
import vue from "@astrojs/vue";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

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
    envPrefix: "WIKI_",
    server: {
      cors: {
        origin: "*",
        methods: ["GET", "POST", "PUT", "DELETE", "PROPFIND", "REPORT", "OPTIONS"],
        allowedHeaders: ["Authorization", "Content-Type", "Depth"],
        maxAge: 86400,
      },
      proxy: {
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
    locales: ["de", "en"],
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
  ],

  adapter: node({
    mode: "middleware",
  }),
});
