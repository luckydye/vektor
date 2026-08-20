import { Route, Router, useParams, useSearchParams } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { isServer } from "solid-js/web";
import { canEdit } from "#acl/permissions.ts";
import { api } from "#api/client.ts";
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
import { useToast } from "#composeables/useToast.ts";
import { extensions } from "#extensions/manager.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { Actions } from "#utils/actions.js";
import { history } from "#utils/history.ts";
import { setClientLang } from "#utils/lang.ts";
import { hasSeenOrganizationTour, markOrganizationTourSeen } from "#utils/onboarding.ts";
import { DEFAULT_SIDEBAR_WIDTH, parseSidebarWidth } from "#utils/sidebarState.ts";
import { AIChatPanel } from "./AIChatPanel.tsx";
import { CalDAVSetupDialog } from "./CalDAVSetupDialog.tsx";
import { CommandPalatte } from "./CommandPalatte.tsx";
import { DockedWindowLayout } from "./DockedWindowLayout.tsx";
import { DocumentOrganizationTour } from "./DocumentOrganizationTour.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { ToastContainer } from "./ToastContainer.tsx";
import { DocumentPageView } from "./views/DocumentPageView.tsx";
import { ExtensionRouteView } from "./views/ExtensionRouteView.tsx";
import { NotFoundView } from "./views/NotFoundView.tsx";
import { SpaceHomeView } from "./views/SpaceHomeView.tsx";
import { SpaceSearchView } from "./views/SpaceSearchView.tsx";
import { SpaceSettingsView } from "./views/SpaceSettingsView.tsx";
import "#utils/insets.ts";
import { Icon } from "./Icon.tsx";

type InitialSpace = Record<string, unknown> & { id?: string; slug?: string };

interface Props {
  url?: string;
  initialSpace?: InitialSpace;
  initialDocument?: Record<string, unknown>;
  initialSidebarWidth?: number;
  replicaScope?: string;
  lang?: string;
}

function stripRouterBase(url: string, base: string) {
  if (base === "/") return url || "/";
  const normalized = base.endsWith("/") ? base.slice(0, -1) : base;
  if (url === normalized) return "/";
  if (url.startsWith(`${normalized}/`)) return url.slice(normalized.length) || "/";
  return url || "/";
}

function DocumentRoute() {
  const params = useParams<{ documentSlug?: string }>();
  return <DocumentPageView documentSlug={params.documentSlug} />;
}

function NewDocumentRoute() {
  const [searchParams] = useSearchParams<{
    type?: string;
    category?: string;
    title?: string;
  }>();
  return (
    <DocumentPageView
      draftType={searchParams.type}
      draftCategory={searchParams.category}
      draftTitle={searchParams.title}
    />
  );
}

export function SpaceApp(props: Props) {
  if (!isServer) {
    setClientLang(props.lang);
    api.setReplicaScope(props.replicaScope);
  }

  const routerBase = props.initialSpace?.slug ? `/${props.initialSpace.slug}/` : "/";
  const ssrRelativeUrl = stripRouterBase(
    (props.url ?? "/").split("?")[0] || "/",
    routerBase,
  );

  const [activeSpaceId] = createSignal<string | null>(
    (props.initialSpace?.id as string | undefined) ?? null,
  );

  const queryClient = islandQueryClient();

  if (props.initialSpace) {
    queryClient.setQueryData(["wiki_spaces"], [props.initialSpace], { stale: true });
  }
  if (props.initialSpace && props.initialDocument) {
    queryClient.setQueryData(
      ["wiki_document_slug", props.initialSpace.id, props.initialDocument.slug],
      props.initialDocument,
    );
  }

  const { currentSpace, currentSpaceId, spaceNotFound } = useSpace(activeSpaceId);
  const toast = useToast();
  const initialSidebarWidth = parseSidebarWidth(props.initialSidebarWidth);
  const [hasMounted, setHasMounted] = createSignal(false);
  const [mobileSidebarOffset, setMobileSidebarOffset] = createSignal(0);
  const [isMobileSidebarDragging, setIsMobileSidebarDragging] = createSignal(false);

  const [showOrganizationTour, setShowOrganizationTour] = createSignal(false);

  /**
   * Offers the organizing tour the first time this browser can actually organize.
   *
   * An effect rather than a line in `onMount` because the role is not always known
   * at mount: without the SSR prop, or on a mid-session promotion, it arrives later.
   */
  let offeredOrganizationTour = false;
  createEffect(() => {
    if (offeredOrganizationTour || !hasMounted()) return;
    if (!canEdit(currentSpace()?.userRole) || hasSeenOrganizationTour()) return;
    offeredOrganizationTour = true;
    setShowOrganizationTour(true);
  });

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

  const registerShellElements = () =>
    Promise.all([
      import("#editor/elements/category-target.ts"),
      import("#editor/elements/page-target.ts"),
      import("#editor/elements/shortcut.ts"),
    ]).catch(console.error);

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

    let redirectingAfterRevocation = false;
    let accessRefresh = Promise.resolve();

    const handleRevocation = () => {
      if (redirectingAfterRevocation) return;
      redirectingAfterRevocation = true;
      toast.show("Your access to this space was revoked.", "error", 10_000);
      setTimeout(() => window.location.assign("/spaces"), 1200);
    };

    const refreshAccess = () => {
      accessRefresh = accessRefresh
        .then(async () => {
          const previousRole = currentSpace()?.userRole;
          const spaces = await api.spaces.get();
          const refreshedSpace = spaces.find((candidate) => candidate.id === spaceId);
          if (!refreshedSpace) {
            handleRevocation();
          } else if (refreshedSpace.userRole !== previousRole) {
            toast.show("Your permissions in this space changed.", "info");
          }
        })
        .catch(console.error);
    };

    const unsubscribeAccessChanges = api.subscribeToRealtimeAccessChanges((change) => {
      if (change.spaceId !== spaceId || change.scope !== "space") return;
      if (change.access === "none") handleRevocation();
      else if (change.access === "refresh") refreshAccess();
    });

    onCleanup(() => {
      unsubscribeAccessChanges();
      window.removeEventListener("resize", resetMobileDrawerOnDesktop);
    });
  });

  const layoutStyle = createMemo(() => ({
    "--sidebar-width": `${initialSidebarWidth}px`,
    "--mobile-sidebar-width": `${Math.max(initialSidebarWidth, DEFAULT_SIDEBAR_WIDTH)}px`,
    "--inset-left": `${initialSidebarWidth}px`,
  }));

  const documentContext = provideDocumentContext();

  const Shell = (shellProps: { children?: unknown }) => (
    <>
      <div
        id="root"
        class="relative mx-auto origin-top overflow-x-clip"
        style={layoutStyle()}
      >
        <div
          class="main-content relative h-full min-h-screen transition-transform md:transition-none"
          style={{
            transform:
              mobileSidebarOffset() === 0
                ? undefined
                : `translateX(${mobileSidebarOffset()}px)`,
            "will-change": mobileSidebarOffset() === 0 ? undefined : "transform",
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
        <Icon class="h-7 w-7" name="command-palette" />
      </button>

      <Show when={hasMounted()}>
        <DocumentOrganizationTour
          show={showOrganizationTour()}
          onUpdateShow={(value) => {
            // Dismissal is the only way out, so this is where "seen" is recorded.
            if (!value) markOrganizationTourSeen();
            setShowOrganizationTour(value);
          }}
        />
        <CalDAVSetupDialog />
        <ToastContainer />
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
