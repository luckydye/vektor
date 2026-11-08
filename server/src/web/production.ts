import { escapeHtml } from "#utils/html.ts";
import { CLIENT_ENTRY, PAGE_META, type PageName } from "./pages.ts";
import type { WebRuntimeSource } from "./runtime.ts";

/** The part of Vite's build manifest the shell reads. */
export interface ClientManifestEntry {
  file: string;
  css?: string[];
  imports?: string[];
}

export type ClientManifest = Record<string, ClientManifestEntry>;

/**
 * Tags for a page: the entry script, the page module's chunk, and everything
 * either imports. Stylesheets block rendering so the server-rendered markup is
 * never shown unstyled, and the chunks are preloaded so the browser fetches them
 * together rather than discovering them one import at a time.
 */
export function pageAssetTags(manifest: ClientManifest, page: PageName): string {
  const root = manifest[CLIENT_ENTRY];
  if (!root) throw new Error("The browser entry is missing from the client build");

  const stylesheets = new Set<string>();
  const chunks = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    const chunk = manifest[key];
    if (!chunk || visited.has(key)) return;
    visited.add(key);
    for (const css of chunk.css ?? []) stylesheets.add(css);
    if (key !== CLIENT_ENTRY) chunks.add(chunk.file);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  visit(CLIENT_ENTRY);
  const module = PAGE_META[page].module;
  if (module) visit(module);

  return [
    ...[...stylesheets].map((file) => `<link rel="stylesheet" href="/${escapeHtml(file)}">`),
    ...[...chunks].map((file) => `<link rel="modulepreload" href="/${escapeHtml(file)}">`),
    `<script type="module" src="/${escapeHtml(root.file)}"></script>`,
  ].join("\n    ");
}

/** The runtime source for a built app: the SSR bundle and the embedded manifest. */
export async function createProductionSource(): Promise<WebRuntimeSource> {
  const { renderPage } = await import("#dist/server/render.js");
  const { clientManifest } = await import("#generated/client-manifest.ts");
  // The manifest is fixed for the life of the process, so each page's tags are too.
  const tags = new Map<PageName, string>();
  return {
    dev: false,
    renderPage,
    assetTags: (page) => {
      let html = tags.get(page);
      if (html === undefined) {
        html = pageAssetTags(clientManifest, page);
        tags.set(page, html);
      }
      return html;
    },
  };
}
