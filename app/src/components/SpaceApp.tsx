import { Route, Router, useParams, useSearchParams } from "@solidjs/router";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { api } from "#api/client.ts";
import { commandPaletteIcon } from "#assets/icons.ts";
import shortcuts from "#assets/shortcuts.json";
import { islandQueryClient } from "#composeables/islandQueryClient.ts";
import { QueryClientContext } from "#composeables/query.ts";
import {
  DocumentContextContext,
  provideDocumentContext,
} from "#composeables/useDocument.ts";
import { SsrUrlContext } from "#composeables/useRoute.ts";
import { ActiveSpaceIdContext, useSpace } from "#composeables/useSpace.ts";
import { useSync } from "#composeables/useSync.ts";
import { extensions } from "#extensions/manager.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { Actions } from "#utils/actions.js";
import { history } from "#utils/history.ts";
import { setClientLang } from "#utils/lang.ts";
import { DEFAULT_SIDEBAR_WIDTH, parseSidebarWidth } from "#utils/sidebarState.ts";
import { AIChatPanel } from "./AIChatPanel.tsx";
import { CalDAVSetupDialog } from "./CalDAVSetupDialog.tsx";
import { CommandPalatte } from "./CommandPalatte.tsx";
import { DockedWindowLayout } from "./DockedWindowLayout.tsx";
import { DocumentOverlay } from "./DocumentOverlay.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { ToastContainer } from "./ToastContainer.tsx";
import { DocumentPageView } from "./views/DocumentPageView.tsx";
import { ExtensionRouteView } from "./views/ExtensionRouteView.tsx";
import { NotFoundView } from "./views/NotFoundView.tsx";
import { SpaceHomeView } from "./views/SpaceHomeView.tsx";
import { SpaceSearchView } from "./views/SpaceSearchView.tsx";
import { SpaceSettingsView } from "./views/SpaceSettingsView.tsx";
import "#utils/insets.ts";

type InitialSpace = Record<string, unknown> & { id?: string; slug?: string };

interface Props {
  url?: string;
  initialSpace?: InitialSpace;
  initialDocument?: Record<string, unknown>;
  initialSidebarWidth?: number;
  replicaScope?: string;
  lang?: string;
}

/**
 * Strips the router base so a URL is relative to it — "/test/doc/foo" becomes
 * "/doc/foo". Anchors carry the full space-scoped URL so middle-click and
 * open-in-new-tab resolve on the server, but the route records are
 * base-relative.
 */
function stripRouterBase(url: string, base: string) {
  if (base === "/") return url || "/";
  const normalized = base.endsWith("/") ? base.slice(0, -1) : base;
  if (url === normalized) return "/";
  if (url.startsWith(`${normalized}/`)) return url.slice(normalized.length) || "/";
  return url || "/";
}

/**
 * Placeholder for a route whose view lands in phase 5.
 *
 * Named rather than blank: phase 4's exit is "the app boots, most routes still
 * blank", and a route that renders nothing is indistinguishable from one that
 * failed to match.
 */
/**
 * `/new` and `/doc/:slug` are the same view; the draft is the case with no
 * slug. The route params are read here rather than inside the view so the view
 * stays a plain component the snapshot harness can mount directly.
 */
function DocumentRoute() {
  const params = useParams<{ documentSlug?: string }>();
  return <DocumentPageView documentSlug={params.documentSlug} />;
}

function NewDocumentRoute() {
  const [searchParams] = useSearchParams<{ type?: string; category?: string }>();
  return (
    <DocumentPageView
      draftType={searchParams.type}
      draftCategory={searchParams.category}
    />
  );
}

export function SpaceApp(props: Props) {
  // The island root sets the document's locale rather than providing it: `t()`
  // is called from 427 sites, most of them plain modules with no component
  // context to read from. On the server the middleware scopes it per request.
  if (!isServer) {
    setClientLang(props.lang);
    api.setReplicaScope(props.replicaScope);
  }

  const routerBase = props.initialSpace?.slug ? `/${props.initialSpace.slug}/` : "/";
  const ssrRelativeUrl = stripRouterBase(props.url ?? "/", routerBase);

  const [activeSpaceId] = createSignal<string | null>(
    (props.initialSpace?.id as string | undefined) ?? null,
  );

  // One client for the island: shared across islands in the browser, fresh per
  // render on the server. See islandQueryClient for why the binding's
  // module-level fallback is not good enough — the seeding just below would
  // otherwise write into a cache shared by every SSR render in the process.
  const queryClient = islandQueryClient();

  // Seed the query cache with SSR-fetched data so children render immediately
  // instead of waiting on their queries.
  if (props.initialSpace) {
    queryClient.setQueryData(["wiki_spaces"], [props.initialSpace], { stale: true });
  }
  if (props.initialSpace && props.initialDocument) {
    queryClient.setQueryData(
      ["wiki_document_slug", props.initialSpace.id, props.initialDocument.slug],
      props.initialDocument,
    );
  }

  const { currentSpaceId, spaceNotFound } = useSpace(activeSpaceId);
  const initialSidebarWidth = parseSidebarWidth(props.initialSidebarWidth);
  const [hasMounted, setHasMounted] = createSignal(false);
  const [mobileSidebarOffset, setMobileSidebarOffset] = createSignal(0);
  const [isMobileSidebarDragging, setIsMobileSidebarDragging] = createSignal(false);

  const isMobileViewport = () => window.matchMedia("(max-width: 767px)").matches;

  function resetMobileDrawerOnDesktop() {
    if (isMobileViewport()) return;
    setIsMobileSidebarDragging(false);
    setMobileSidebarOffset(0);
  }

  useSync(currentSpaceId, [realtimeTopics.extensions], (topics) => {
    const spaceId = currentSpaceId();
    if (!topics.includes(realtimeTopics.extensions) || !spaceId) return;
    queryClient.invalidateQueries({ queryKey: ["extensions", spaceId] });
    void extensions.refresh(spaceId).catch(console.error);
  });

  /**
   * Lightweight chrome elements every route needs — the sidebar tree targets,
   * shortcut hints and the mobile drawer. Registered eagerly.
   */
  const registerShellElements = () =>
    Promise.all([
      import("#editor/elements/scroll.ts"),
      import("#editor/elements/category-target.ts"),
      import("#editor/elements/page-target.ts"),
      import("#editor/elements/shortcut.ts"),
      import("#editor/elements/drawer.ts"),
    ]).catch(console.error);

  /**
   * Heavy document/editor elements — these pull in TipTap, Yjs and embeds. They
   * only render inside document content, so they stay off the initial-render
   * path. Custom elements upgrade once defined and the renderers tolerate late
   * registration, so deferring is safe.
   */
  const registerDocumentElements = () =>
    Promise.all([
      import("#editor/document.ts"),
      import("#editor/elements/figma-embed.ts"),
      import("#editor/elements/html-block.ts"),
      import("#editor/elements/ticket-link.ts"),
      import("#editor/elements/user-mention.ts"),
      import("#editor/elements/cake.ts"),
    ]).catch(console.error);

  onMount(() => {
    setHasMounted(true);
    window.addEventListener("resize", resetMobileDrawerOnDesktop);
    void registerShellElements();

    const idle = (
      window as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
      }
    ).requestIdleCallback;
    if (idle) idle(() => void registerDocumentElements(), { timeout: 1500 });
    else setTimeout(() => void registerDocumentElements(), 200);

    navigator.serviceWorker.register("/sw.js").catch(console.error);

    for (const [shortcut, actions] of Object.entries(shortcuts)) {
      for (const action of Array.isArray(actions) ? actions : [actions]) {
        Actions.mapShortcut(shortcut, action);
      }
    }

    void history.log(location.pathname, document.title);

    const spaceId = activeSpaceId();
    if (spaceId) extensions.init(spaceId).catch(console.error);

    onCleanup(() => window.removeEventListener("resize", resetMobileDrawerOnDesktop));
  });

  const layoutStyle = createMemo(() => ({
    "--sidebar-width": `${initialSidebarWidth}px`,
    "--mobile-sidebar-width": `${Math.max(initialSidebarWidth, DEFAULT_SIDEBAR_WIDTH)}px`,
    "--inset-left": `${initialSidebarWidth}px`,
  }));

  // Provided at this level because the writer is `DocumentPageView` and the
  // readers are both under it (`DocumentActions`) and beside it in the shell
  // (`AIChatPanel`), so this is the only scope that covers everyone.
  const documentContext = provideDocumentContext();

  const Shell = (shellProps: { children?: unknown }) => (
    <>
      <div
        id="root"
        class="relative mx-auto origin-top overflow-x-clip"
        style={layoutStyle()}
      >
        <div
          class="main-content relative h-full min-h-screen transition-transform will-change-transform md:transition-none"
          style={{
            transform: `translateX(${mobileSidebarOffset()}px)`,
            transition: isMobileSidebarDragging() ? "none" : undefined,
          }}
        >
          <DockedWindowLayout />

          <Show
            when={!spaceNotFound()}
            fallback={
              <div class="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-neutral-500">
                <p class="font-semibold text-2xl text-neutral-800">404</p>
                <p>Space not found.</p>
                <a href="/" class="text-sm underline hover:text-neutral-800">
                  Go home
                </a>
              </div>
            }
          >
            {shellProps.children as never}
          </Show>
        </div>

        <Sidebar
          initialWidth={initialSidebarWidth}
          onMobileDragChange={(offset) => {
            if (!isMobileViewport()) return;
            setIsMobileSidebarDragging(offset !== null);
            if (offset !== null) setMobileSidebarOffset(offset);
          }}
          onMobileOpenChange={(open, width) => {
            if (!isMobileViewport()) return;
            setMobileSidebarOffset(open ? width : 0);
          }}
        />
      </div>

      <button
        type="button"
        class="fixed right-xs bottom-s z-30 flex h-14 w-14 items-center justify-center rounded-full bg-primary-100 text-white shadow-lg transition-colors hover:bg-primary-200 active:bg-primary-300 md:hidden"
        aria-label="Open command palette"
        title="Open command palette"
        onClick={() => Actions.run("ui:toggle:palatte")}
      >
        <span class="svg-icon h-7 w-7" innerHTML={commandPaletteIcon} />
      </button>

      {/* A mounted flag, *not* `<Show when={!isServer}>`.
          
          `isServer` is false during hydration, so the client would render these
          on its first pass while the server rendered nothing — and Solid's
          hydration then fails outright with "Unable to find DOM nodes for
          hydration key", taking the whole island down. Measured: the toast
          container never appeared and the palette threw.
          
          This is the same conclusion as ticket 1380, and it holds on both
          sides: for *rendering* inside a hydrated island the guard has to be a
          post-hydration flag. `isServer` is for code paths that must not run on
          the server, not for withholding markup. */}
      <Show when={hasMounted()}>
        <CalDAVSetupDialog />
        <ToastContainer />
        <DocumentOverlay />
        <AIChatPanel documentId={documentContext[0]().documentId ?? ""} />
        <CommandPalatte />
      </Show>
    </>
  );

  return (
    <QueryClientContext.Provider value={queryClient}>
      <ActiveSpaceIdContext.Provider value={activeSpaceId}>
        <SsrUrlContext.Provider value={ssrRelativeUrl}>
          <DocumentContextContext.Provider value={documentContext}>
            {/* `url` is the server's only route source. `Router` delegates to
              `StaticRouter` when `isServer`, and that reads `props.url`,
              falling back to SolidStart's request event — which does not exist
              under Astro — and then to `""`. Without this every SSR matched
              `/` and served the space home for every path, so hydrating any
              other route walked markup for a tree that was never rendered and
              threw. The client ignores it and reads `window.location`.

              It gets the full path, not the base-relative one: the client
              source is `window.location.pathname`, and the router strips
              `base` itself. Handing it a pre-stripped path strips twice. */}
            <Router
              url={props.url ?? "/"}
              base={routerBase === "/" ? undefined : routerBase.replace(/\/$/, "")}
              root={Shell}
            >
              <Route path="/" component={SpaceHomeView} />
              <Route path="/search" component={SpaceSearchView} />
              <Route path="/new" component={NewDocumentRoute} />
              <Route path="/settings" component={SpaceSettingsView} />
              <Route path="/doc/*documentSlug" component={DocumentRoute} />
              <Route path="/x/*extensionPath" component={ExtensionRouteView} />
              <Route path="*" component={NotFoundView} />
            </Router>
          </DocumentContextContext.Provider>
        </SsrUrlContext.Provider>
      </ActiveSpaceIdContext.Provider>
    </QueryClientContext.Provider>
  );
}
