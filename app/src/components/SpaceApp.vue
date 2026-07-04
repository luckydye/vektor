<script setup lang="ts">
import { getCurrentInstance, onMounted, onUnmounted, provide, ref, watch } from "vue";
import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
  RouterView,
} from "vue-router";
import { useQueryClient } from "../composeables/query.ts";
import { provideDocumentContext } from "../composeables/useDocument.ts";
import { useRoute } from "../composeables/useRoute.ts";
import { useSpace } from "../composeables/useSpace.ts";
import shortcuts from "../config/shortcuts.json";
import strings from "../config/strings.json";
import { Actions } from "../utils/actions.js";
import { extensions } from "../utils/extensions.ts";
import { history } from "../utils/history.ts";
import { parseSidebarWidth } from "../utils/sidebarState.ts";
import AIChatPanel from "./AIChatPanel.vue";
import CalDAVSetupDialog from "./CalDAVSetupDialog.vue";
import ClientOnly from "./ClientOnly.vue";
import CommandPalatte from "./CommandPalatte.vue";
import DockedWindowLayout from "./DockedWindowLayout.vue";
import DocumentOverlay from "./DocumentOverlay.vue";
import MobileHeader from "./MobileHeader.vue";
import Sidebar from "./Sidebar.vue";
import ToastContainer from "./ToastContainer.vue";
import DocumentPageView from "./views/DocumentPageView.vue";
import ExtensionRouteView from "./views/ExtensionRouteView.vue";
import NotFoundView from "./views/NotFoundView.vue";
import SpaceHomeView from "./views/SpaceHomeView.vue";
import SpaceSearchView from "./views/SpaceSearchView.vue";
import SpaceSettingsView from "./views/SpaceSettingsView.vue";
import "../utils/insets.ts";

type InitialSpace = Record<string, unknown> & {
  id?: string;
  slug?: string;
};

const props = defineProps<{
  url?: string;
  initialSpace?: InitialSpace;
  initialDocument?: Record<string, unknown>;
  initialSidebarWidth?: number;
}>();

const isServer = typeof window === "undefined";

const routerBase = props.initialSpace?.slug ? `/${props.initialSpace.slug}/` : "/";

const router = createRouter({
  history: isServer ? createMemoryHistory(routerBase) : createWebHistory(routerBase),
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
  router.afterEach((to) => {
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

const { pathname } = useRoute();
const { currentSpaceId, currentSpace, spaceNotFound } = useSpace();
const documentContext = provideDocumentContext();
const isMobileSidebarOpen = ref(false);

const lang =
  typeof document !== "undefined" ? document.documentElement.lang || "en" : "en";
globalThis._translations = strings;

const initialSidebarWidth = parseSidebarWidth(props.initialSidebarWidth);
const initialLayoutStyle = {
  "--sidebar-width": `${initialSidebarWidth}px`,
  "--inset-left": `${initialSidebarWidth}px`,
};

onMounted(async () => {
  document.addEventListener("click", handleDocumentClick);

  await Promise.all([
    import("../editor/elements/textarea.ts"),
    import("../editor/elements/expression.ts"),
    import("../editor/document.ts"),
    import("../editor/elements/figma-embed.ts"),
    import("../editor/elements/html-block.ts"),
    import("../editor/elements/ticket-link.ts"),
    import("../editor/elements/user-mention.ts"),
    import("../editor/elements/scroll.ts"),
    import("../editor/elements/page-target.ts"),
    import("../editor/elements/category-target.ts"),
    import("../editor/elements/drawer.ts"),
    import("../editor/elements/shortcut.ts"),
    import("./document-statusbar.ts"),
    import("../editor/elements/table-view.ts"),
    import("../editor/elements/cake.ts"),
  ]);

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
  }
});
</script>

<template>
  <div id="root" class="mx-auto relative origin-top" :style="initialLayoutStyle">
    <div
      :class="[
        'main-content min-h-screen h-full transition-transform md:transition-none relative',
        isMobileSidebarOpen ? 'translate-x-(--sidebar-width) md:translate-x-0' : '',
      ]"
    >
      <MobileHeader
        :spaceName="currentSpace?.name ?? ''"
        :pathname="pathname"
      />

      <DockedWindowLayout />

      <div v-if="spaceNotFound" class="flex flex-col items-center justify-center min-h-[60vh] gap-3 text-neutral-500">
        <p class="text-2xl font-semibold text-neutral-800">404</p>
        <p>Space not found.</p>
        <a href="/" class="text-sm underline hover:text-neutral-800">Go home</a>
      </div>
      <RouterView v-else />
    </div>

    <Sidebar
      :initialWidth="initialSidebarWidth"
      @mobile-open-change="isMobileSidebarOpen = $event"
    />
  </div>

  <ClientOnly>
    <CalDAVSetupDialog />
    <ToastContainer />
    <DocumentOverlay />
    <AIChatPanel :documentId="documentContext.documentId ?? ''" />
    <CommandPalatte />
  </ClientOnly>
</template>
