import { type Component, Suspense } from "solid-js";
import { generateHydrationScript, NoHydration, renderToStringAsync } from "solid-js/web";
import { PAGE_META, type PageName } from "./pages.ts";
import { DesktopLoginPage, type DesktopLoginPageProps } from "./pages/DesktopLoginPage.tsx";
import {
  DocsIndexPage,
  type DocsIndexPageProps,
  DocsMarkdownPage,
  type DocsMarkdownPageProps,
} from "./pages/DocsPages.tsx";
import { LoginPage, type LoginPageProps } from "./pages/LoginPage.tsx";
import { NotFoundPage, type NotFoundPageProps } from "./pages/NotFoundPage.tsx";
import { SharePage, type SharePageProps } from "./pages/SharePage.tsx";
import { SpacePage, type SpacePageProps } from "./pages/SpacePage.tsx";
import { SpacesPage, type SpacesPageProps } from "./pages/SpacesPage.tsx";

/**
 * The server-rendering entry, built into `dist/server/render.js` (and loaded
 * through Vite in development). Everything that renders a component lives
 * behind it, so the code that talks to the database never has to be bundled
 * with the UI.
 */

export interface PageProps {
  login: LoginPageProps;
  desktopLogin: DesktopLoginPageProps;
  spaces: SpacesPageProps;
  space: SpacePageProps;
  notFound: NotFoundPageProps;
  share: SharePageProps;
  docsIndex: DocsIndexPageProps;
  docsMarkdown: DocsMarkdownPageProps;
}

const PAGES: { [N in PageName]: Component<PageProps[N]> } = {
  login: LoginPage,
  desktopLogin: DesktopLoginPage,
  spaces: SpacesPage,
  space: SpacePage,
  notFound: NotFoundPage,
  share: SharePage,
  docsIndex: DocsIndexPage,
  docsMarkdown: DocsMarkdownPage,
};

export interface RenderedPage {
  /** The page's markup, which goes inside the root element. */
  html: string;
  /** What must run before the browser's bundle to hydrate it; empty for a static page. */
  hydrationScript: string;
}

export async function renderPage<N extends PageName>(
  name: N,
  props: PageProps[N],
): Promise<RenderedPage> {
  const Page = PAGES[name] as Component<PageProps[N]>;
  if (!PAGE_META[name].hydrate) {
    const html = await renderToStringAsync(
      () => (
        <NoHydration>
          <Page {...props} />
        </NoHydration>
      ),
      { noScripts: true } as never,
    );
    return { html, hydrationScript: "" };
  }

  const html = await renderToStringAsync(() => (
    <Suspense>
      <Page {...props} />
    </Suspense>
  ));
  return { html, hydrationScript: generateHydrationScript() };
}
