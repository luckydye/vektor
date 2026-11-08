/**
 * What the shell needs to know about each page without loading its component:
 * which chrome it sits in, whether the browser takes over the server-rendered
 * markup, and which module the browser loads for it.
 *
 * `module` is the source path of what `client.tsx` imports for the page. It is
 * only used to name that chunk's stylesheets and preloads in the page head, so
 * a page whose path is wrong still works, just without them.
 */
export const PAGE_META = {
  login: {
    variant: "landing",
    hydrate: true,
    module: "src/web/pages/LoginPage.tsx",
  },
  desktopLogin: {
    variant: "landing",
    hydrate: true,
    module: "src/web/pages/DesktopLoginPage.tsx",
  },
  spaces: { variant: "app", hydrate: true, module: "src/web/pages/SpacesPage.tsx" },
  space: { variant: "app", hydrate: true, module: "src/web/pages/SpacePage.tsx" },
  notFound: { variant: "app", hydrate: false, module: undefined },
  share: { variant: "app", hydrate: false, module: "src/web/share/client.ts" },
  docsIndex: { variant: "landing", hydrate: false, module: "src/web/docs/client.ts" },
  docsMarkdown: {
    variant: "landing",
    hydrate: false,
    module: "src/web/docs/client.ts",
  },
} as const satisfies Record<
  string,
  { variant: "app" | "landing"; hydrate: boolean; module: string | undefined }
>;

export type PageName = keyof typeof PAGE_META;

/** The one browser entry, which also keys the build manifest. */
export const CLIENT_ENTRY = "src/web/client.tsx";

/** The stylesheet every page needs before it first paints. */
export const GLOBAL_STYLES = "src/styles/index.css";

/**
 * Where the server puts the page's markup and its data — `{ page, props }`, the
 * props only for a page the browser hydrates — and the browser looks for them.
 */
export const PAGE_DATA_ID = "page-data";
export const PAGE_ROOT_ID = "app";
