import { escapeHtml } from "#utils/html.ts";
import { createServer, type ViteDevServer } from "vite";
import { resolve } from "node:path";
import { CLIENT_ENTRY, GLOBAL_STYLES } from "./pages.ts";
import type { WebRuntimeSource } from "./runtime.ts";

export interface DevWeb {
  source: WebRuntimeSource;
  /** Vite's module, HMR and public-file middleware, as a Node request handler. */
  middleware: ViteDevServer["middlewares"];
  stop(): Promise<void>;
}

/**
 * The web frontend served from source: Vite runs in middleware mode inside this
 * process, transforming browser modules on request and loading the component
 * renderer through the same module graph, so a page renders from the code the
 * browser is about to run.
 */
export async function startDevWeb(): Promise<DevWeb> {
  const vite = await createServer({
    root: "./",
    logLevel: "error",
    server: {
      middlewareMode: true,
      // The page is reached under whatever name the machine has, not just localhost.
      allowedHosts: true,
      cors: {
        origin: "*",
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Authorization", "Content-Type"],
        maxAge: 86400,
      },
    },
  });

  return {
    middleware: vite.middlewares,
    stop: () => vite.close(),
    source: {
      dev: true,
      async renderPage(name, props) {
        const module = (await vite.ssrLoadModule("/src/web/render.tsx")) as typeof import("./render.tsx");
        return module.renderPage(name, props);
      },
      assetTags: async () => {
        // Vite adds a module's CSS from script, after the first paint, which
        // flashes the page unstyled. The stylesheet goes in the head instead,
        // under the id Vite's client looks for, so it takes that tag over for
        // hot updates rather than adding a second one.
        const styles = await vite.environments.client.transformRequest(
          `/${GLOBAL_STYLES}?direct`,
        );
        return [
          styles
            ? `<style type="text/css" data-vite-dev-id="${escapeHtml(resolve(GLOBAL_STYLES))}">${styles.code}</style>`
            : "",
          `<script type="module" src="/@vite/client"></script>`,
          `<script type="module" src="/${CLIENT_ENTRY}"></script>`,
        ].join("\n    ");
      },
    },
  };
}
