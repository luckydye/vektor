import { PAGE_META, type PageName } from "./pages.ts";
import type { PageProps, RenderedPage } from "./render.tsx";
import { renderDocument } from "./shell.ts";

/**
 * How pages become HTML. Development and production differ in two places only:
 * where the component renderer comes from (Vite's module loader, or the
 * `dist/server/render.js` bundle) and which tags load a browser entry (Vite's
 * dev server, or the hashed files in the build manifest).
 */
export interface WebRuntimeSource {
  renderPage<N extends PageName>(name: N, props: PageProps[N]): Promise<RenderedPage>;
  /** Script and link tags that load the browser code for `page`. */
  assetTags(page: PageName): string | Promise<string>;
  dev: boolean;
}

/** What a page contributes to the document around it. */
export interface PageContext {
  lang: string;
  title: string;
  publicEnv: App.PublicEnv;
  brandColor?: string;
  spaceId?: string;
}

export interface WebRuntime {
  /** Renders `name` with `props` into a complete HTML response. */
  html<N extends PageName>(
    name: N,
    props: PageProps[N],
    context: PageContext,
    init?: ResponseInit,
  ): Promise<Response>;
}

export function createWebRuntime(source: WebRuntimeSource): WebRuntime {
  return {
    async html(name, props, context, init) {
      const page = PAGE_META[name];
      const rendered = await source.renderPage(name, props);
      const document = renderDocument({
        ...context,
        variant: page.variant,
        body: rendered.html,
        hydrationScript: rendered.hydrationScript,
        assetTags: await source.assetTags(name),
        page: name,
        pageProps: page.hydrate ? props : undefined,
        dev: source.dev,
      });
      const headers = new Headers(init?.headers);
      headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(document, { ...init, headers });
    },
  };
}
