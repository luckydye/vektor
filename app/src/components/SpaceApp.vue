<script setup lang="ts">
import { computed, getCurrentInstance, onMounted, onUnmounted, provide, ref } from "vue";
import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
  RouterView,
} from "vue-router";
import { api } from "#api/client.ts";
import { commandPaletteIcon } from "#assets/icons.ts";
import shortcuts from "#assets/shortcuts.json";
import { useQueryClient } from "#composeables/query.ts";
import { provideDocumentContext } from "#composeables/useDocument.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useSync } from "#composeables/useSync.ts";
import { extensions } from "#extensions/manager.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { Actions } from "#utils/actions.js";
import { history } from "#utils/history.ts";
import { currentLang, languageInjectionKey } from "#utils/lang.ts";
// Side effect: registers the Vue-injected locale lookup with `lang.ts`, which
// stays framework-free so server-side document serialization does not load Vue.
import { DEFAULT_SIDEBAR_WIDTH, parseSidebarWidth } from "#utils/sidebarState.ts";
import AIChatPanel from "./AIChatPanel.vue";
import CalDAVSetupDialog from "./CalDAVSetupDialog.vue";
import ClientOnly from "./ClientOnly.vue";
import CommandPalatte from "./CommandPalatte.vue";
import DockedWindowLayout from "./DockedWindowLayout.vue";
import DocumentOverlay from "./DocumentOverlay.vue";
import Sidebar from "./Sidebar.vue";
import ToastContainer from "./ToastContainer.vue";
import DocumentPageView from "./views/DocumentPageView.vue";
import ExtensionRouteView from "./views/ExtensionRouteView.vue";
import NotFoundView from "./views/NotFoundView.vue";
import SpaceHomeView from "./views/SpaceHomeView.vue";
import SpaceSearchView from "./views/SpaceSearchView.vue";
import SpaceSettingsView from "./views/SpaceSettingsView.vue";
import "#utils/insets.ts";

type InitialSpace = Record<string, unknown> & {
  id?: string;
  slug?: string;
};

const props = defineProps<{
  url?: string;
  initialSpace?: InitialSpace;
  initialDocument?: Record<string, unknown>;
  initialSidebarWidth?: number;
  replicaScope?: string;
  lang?: string;
}>();

provide(languageInjectionKey, props.lang ?? currentLang());

const isServer = typeof window === "undefined";

if (!isServer) {
  api.setReplicaScope(props.replicaScope);
}

const routerBase = props.initialSpace?.slug ? `/${props.initialSpace.slug}/` : "/";

const router = createRouter({
  history: isServer ? createMemoryHistory(routerBase) : createWebHistory(routerBase),
  scrollBehavior: (_to, _from, savedPosition) => savedPosition ?? { left: 0, top: 0 },
  routes: [
    { path: "/", component: SpaceHomeView },
    { path: "/search", component: SpaceSearchView },
    {
      path: "/new",
      component: DocumentPageView,
      props: (route) => ({
        draftType: (route.query.type as string) ?? "",
        draftCategory: (route.query.category as string) ?? "",
      }),
    },
    { path: "/settings", component: SpaceSettingsView },
    {
      path: "/doc/:documentSlug(.*)",
      component: DocumentPageView,
      props: (route) => ({ documentSlug: route.params.documentSlug }),
    },
    { path: "/x/:pathMatch(.*)*", component: ExtensionRouteView },
    { path: "/rev/:id", redirect: "/" },
    { path: "/:pathMatch(.*)*", component: NotFoundView },
  ],
});

if (!isServer) {
  router.afterEach((to, from) => {
    // Query/hash-only replacements are UI state written to the URL (an open
    // revision, the current search terms, the selected workflow run), not pages
    // the user navigated to — keep them out of the recently-visited list.
    if (to.path === from.path) return;
    history.log(to.fullPath, document.title);
  });
}

function isInternalHref(href: string | null): href is string {
  if (!href) return false;
  if (!href.startsWith("/") || href.startsWith("//")) return false;
  if (href.startsWith("/api/") || href.startsWith("/_")) return false;
  return true;
}

function internalPathFromUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, window.location.origin);
  } catch {
    return null;
  }

  if (url.origin !== window.location.origin) return null;

  const path = `${url.pathname}${url.search}${url.hash}`;
  return isInternalHref(path) ? path : null;
}

function handleDocumentClick(e: MouseEvent) {
  // Let the browser handle modifier-clicks (new tab/window) and middle-click
  // (new tab) instead of hijacking them into an SPA navigation.
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

  const anchor = (e.target as Element).closest("a");
  if (!anchor) return;
  if (anchor.getAttribute("target") === "_blank") return;
  if (anchor.hasAttribute("download")) return;

  const path = internalPathFromUrl(anchor.getAttribute("href") ?? "");
  if (!path) return;

  e.preventDefault();
  // Anchors carry the full space-scoped URL (e.g. "/{spaceSlug}/doc/foo") so
  // middle-click / open-in-new-tab resolve on the server. Strip the router base
  // before pushing so the SPA matches the base-relative route records.
  router.push(stripRouterBase(path, routerBase));
}

const instance = getCurrentInstance();
if (instance) {
  instance.appContext.app.use(router);
}

function stripRouterBase(url: string, base: string) {
  if (base === "/") return url || "/";

  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  if (url === normalizedBase) return "/";
  if (url.startsWith(`${normalizedBase}/`)) {
    return url.slice(normalizedBase.length) || "/";
  }
  return url || "/";
}

// Strip the router base so the URL is relative to the base (e.g. "/test/doc/foo" -> "/doc/foo").
// createMemoryHistory(routerBase) and createWebHistory(routerBase) both expect base-relative paths.
const ssrRelativeUrl = (() => {
  const url = props.url ?? "/";
  return stripRouterBase(url, routerBase);
})();

if (isServer) {
  await router.push(ssrRelativeUrl);
}
await router.isReady();

// Provide initial URL so useRoute() can parse params before the router's
// async initial navigation completes.
provide("ssr:url", ssrRelativeUrl);
provide("ssr:now", Date.now());

// Provide the server-resolved space ID as the source of truth.
// useSpace() reads this instead of deriving the active space from the URL slug.
const activeSpaceId = ref<string | null>(props.initialSpace?.id ?? null);
provide("space:activeId", activeSpaceId);

// Seed the query cache with SSR-fetched data so child components render
// immediately without waiting for async queries.
const queryClient = useQueryClient();
if (props.initialSpace) {
  queryClient.setQueryData(["wiki_spaces"], [props.initialSpace], { stale: true });
}
if (props.initialSpace && props.initialDocument) {
  queryClient.setQueryData(
    ["wiki_document_slug", props.initialSpace.id, props.initialDocument.slug],
    props.initialDocument,
  );
}

// A component cannot inject a value it provides itself, so pass the active ID
// directly here. Descendants continue to receive it through provide().
const { currentSpaceId, spaceNotFound } = useSpace(activeSpaceId);
const documentContext = provideDocumentContext();
const initialSidebarWidth = parseSidebarWidth(props.initialSidebarWidth);
const initialLayoutStyle = {
  "--sidebar-width": `${initialSidebarWidth}px`,
  "--mobile-sidebar-width": `${Math.max(initialSidebarWidth, DEFAULT_SIDEBAR_WIDTH)}px`,
  "--inset-left": `${initialSidebarWidth}px`,
};
const mobileSidebarOffset = ref(0);
const isMobileSidebarDragging = ref(false);

const mobileSidebarStyle = computed(() => ({
  transform: `translateX(${mobileSidebarOffset.value}px)`,
  transition: isMobileSidebarDragging.value ? "none" : undefined,
}));

function isMobileViewport() {
  return window.matchMedia("(max-width: 767px)").matches;
}

function handleMobileDrawerDrag(offset: number | null) {
  if (!isMobileViewport()) return;
  isMobileSidebarDragging.value = offset !== null;
  if (offset !== null) mobileSidebarOffset.value = offset;
}

function handleMobileSidebarOpen(open: boolean, width: number) {
  if (!isMobileViewport()) return;
  mobileSidebarOffset.value = open ? width : 0;
}

function resetMobileDrawerOnDesktop() {
  if (isMobileViewport()) return;
  isMobileSidebarDragging.value = false;
  mobileSidebarOffset.value = 0;
}

useSync(currentSpaceId, [realtimeTopics.extensions], (topics) => {
  if (!topics.includes(realtimeTopics.extensions) || !currentSpaceId.value) return;

  queryClient.invalidateQueries({ queryKey: ["extensions", currentSpaceId.value] });
  void extensions.refresh(currentSpaceId.value).catch(console.error);
});

// Lightweight custom elements the app chrome needs on every route: the sidebar
// document tree (category/page targets, scroller), keyboard-shortcut hints, and
// the mobile document drawer. Register these eagerly.
function registerShellElements() {
  return Promise.all([
    import("#editor/elements/scroll.ts"),
    import("#editor/elements/category-target.ts"),
    import("#editor/elements/page-target.ts"),
    import("#editor/elements/shortcut.ts"),
    import("#editor/elements/drawer.ts"),
  ]).catch(console.error);
}

// Heavy document/editor content elements — these pull in TipTap, Yjs and
// embeds. They only ever render inside document content, so keep them
// off the initial-render/hydration critical path. Custom elements upgrade
// automatically once defined, and the document renderers (e.g. PinnedDocument)
// already tolerate late registration, so deferring is safe.
function registerDocumentElements() {
  return Promise.all([
    import("#editor/document.ts"), // also registers textarea + expression
    import("#editor/elements/figma-embed.ts"),
    import("#editor/elements/html-block.ts"),
    import("#editor/elements/ticket-link.ts"),
    import("#editor/elements/user-mention.ts"),
    import("#editor/elements/cake.ts"),
  ]).catch(console.error);
}

onMounted(() => {
  document.addEventListener("click", handleDocumentClick);
  window.addEventListener("resize", resetMobileDrawerOnDesktop);

  registerShellElements();

  const idle = (
    window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
    }
  ).requestIdleCallback;
  if (idle) {
    idle(() => registerDocumentElements(), { timeout: 1500 });
  } else {
    setTimeout(() => registerDocumentElements(), 200);
  }

  navigator.serviceWorker.register("/sw.js").catch(console.error);

  for (const [shortcut, actions] of Object.entries(shortcuts)) {
    for (const action of Array.isArray(actions) ? actions : [actions]) {
      Actions.mapShortcut(shortcut, action);
    }
  }

  history.log(location.pathname, document.title);

  if (activeSpaceId.value) {
    extensions.init(activeSpaceId.value).catch(console.error);
  }
});

onUnmounted(() => {
  if (!isServer) {
    document.removeEventListener("click", handleDocumentClick);
    window.removeEventListener("resize", resetMobileDrawerOnDesktop);
  }
});
</script>

<template>
  <div
    id="root"
    class="mx-auto relative origin-top overflow-x-clip"
    :style="initialLayoutStyle"
  >
    <div
      class="main-content min-h-screen h-full relative transition-transform md:transition-none will-change-transform"
      :style="mobileSidebarStyle"
    >
      <DockedWindowLayout />

      <div
        v-if="spaceNotFound"
        class="flex flex-col items-center justify-center min-h-[60vh] gap-3 text-neutral-500"
      >
        <p class="text-2xl font-semibold text-neutral-800">404</p>
        <p>Space not found.</p>
        <a href="/" class="text-sm underline hover:text-neutral-800">Go home</a>
      </div>
      <RouterView v-else />
    </div>

    <Sidebar
      :initialWidth="initialSidebarWidth"
      @mobile-drag-change="handleMobileDrawerDrag"
      @mobile-open-change="handleMobileSidebarOpen"
    />
  </div>

  <button
    type="button"
    class="fixed bottom-s right-xs z-30 flex h-14 w-14 items-center justify-center rounded-full bg-primary-100 text-white shadow-lg transition-colors hover:bg-primary-200 active:bg-primary-300 md:hidden"
    aria-label="Open command palette"
    title="Open command palette"
    @click="Actions.run('ui:toggle:palatte')"
  >
    <span class="svg-icon h-7 w-7" v-html="commandPaletteIcon" />
  </button>

  <ClientOnly>
    <CalDAVSetupDialog />
    <ToastContainer />
    <DocumentOverlay />
    <AIChatPanel :documentId="documentContext.documentId ?? ''" />
    <CommandPalatte />
  </ClientOnly>
</template>
