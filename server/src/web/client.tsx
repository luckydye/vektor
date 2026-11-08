import "#components/title-bar.ts";
import "#styles/index.css";
import { hydratePage } from "./hydrate.tsx";
import { PAGE_DATA_ID, type PageName } from "./pages.ts";

/**
 * The browser entry for every page. It loads only the code of the page the
 * server rendered: a login screen does not download the editor.
 */
const PAGE_CLIENTS: Record<PageName, (props: unknown) => Promise<unknown> | undefined> = {
  login: (props) =>
    import("./pages/LoginPage.tsx").then((m) => hydratePage(m.LoginPage, props)),
  desktopLogin: (props) =>
    import("./pages/DesktopLoginPage.tsx").then((m) =>
      hydratePage(m.DesktopLoginPage, props),
    ),
  spaces: (props) =>
    import("./pages/SpacesPage.tsx").then((m) => hydratePage(m.SpacesPage, props)),
  space: (props) =>
    import("./pages/SpacePage.tsx").then((m) => hydratePage(m.SpacePage, props)),
  // Rendered once on the server; the browser only upgrades its custom elements.
  notFound: () => undefined,
  share: () => import("./share/client.ts"),
  docsIndex: () => import("./docs/client.ts"),
  docsMarkdown: () => import("./docs/client.ts"),
};

const data: { page: PageName; props?: unknown } = JSON.parse(
  document.getElementById(PAGE_DATA_ID)?.textContent ?? "{}",
);
if (data.page) void PAGE_CLIENTS[data.page](data.props);
