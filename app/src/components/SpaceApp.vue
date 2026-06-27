<script setup lang="ts">
import { getCurrentInstance, onMounted, onUnmounted, provide, watch } from "vue";
import { createMemoryHistory, createRouter, createWebHistory, RouterView } from "vue-router";
import CalDAVSetupDialog from "./CalDAVSetupDialog.vue";
import ClientOnly from "./ClientOnly.vue";
import CommandPalatte from "./CommandPalatte.vue";
import DockedWindowLayout from "./DockedWindowLayout.vue";
import DocumentOverlay from "./DocumentOverlay.vue";
import MobileHeader from "./MobileHeader.vue";
import Sidebar from "./Sidebar.vue";
import ToastContainer from "./ToastContainer.vue";
import AIChatPanel from "./AIChatPanel.vue";
import DocumentPageView from "./views/DocumentPageView.vue";
import ExtensionRouteView from "./views/ExtensionRouteView.vue";
import NewDocumentView from "./views/NewDocumentView.vue";
import NotFoundView from "./views/NotFoundView.vue";
import SpaceHomeView from "./views/SpaceHomeView.vue";
import SpaceSearchView from "./views/SpaceSearchView.vue";
import SpaceSettingsView from "./views/SpaceSettingsView.vue";
import { useDocumentContext } from "../composeables/useDocument.ts";
import { useQueryClient } from "../composeables/query.ts";
import { useRoute } from "../composeables/useRoute.ts";
import { useSpace } from "../composeables/useSpace.ts";
import strings from "../config/strings.json";
import { Actions } from "../utils/actions.js";
import shortcuts from "../config/shortcuts.json";
import { extensions } from "../utils/extensions.ts";
import { history } from "../utils/history.ts";
import { initInsets } from "../utils/insets.ts";

const props = defineProps<{
  url?: string;
  initialSpace?: Record<string, any>;
  initialDocument?: Record<string, any>;
}>();

const isServer = typeof window === "undefined";

const router = createRouter({
  history: isServer ? createMemoryHistory(props.url ?? "/") : createWebHistory(),
  routes: [
    { path: "/:spaceSlug", component: SpaceHomeView },
    { path: "/:spaceSlug/search", component: SpaceSearchView },
    { path: "/:spaceSlug/new", component: NewDocumentView },
    { path: "/:spaceSlug/settings", component: SpaceSettingsView },
    {
      path: "/:spaceSlug/doc/:documentSlug(.*)",
      component: DocumentPageView,
      props: (route) => ({ documentSlug: route.params.documentSlug }),
    },
    { path: "/:spaceSlug/x/:pathMatch(.*)*", component: ExtensionRouteView },
    { path: "/:spaceSlug/rev/:id", redirect: (to) => `/${to.params.spaceSlug}` },
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
  router.push(path);
}

const instance = getCurrentInstance();
if (instance) {
  instance.appContext.app.use(router);
}

if (isServer) {
  await router.push(props.url ?? "/");
}
await router.isReady();

// Provide initial URL so useRoute() can parse params before the router's
// async initial navigation completes.
provide("ssr:url", props.url ?? "");
provide("ssr:now", Date.now());

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
const { documentContext } = useDocumentContext();

const lang = typeof document !== "undefined" ? document.documentElement.lang || "en" : "en";
globalThis._translations = strings;

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

  initInsets();

  for (const [shortcut, actions] of Object.entries(shortcuts)) {
    for (const action of Array.isArray(actions) ? actions : [actions]) {
      Actions.mapShortcut(shortcut, action);
    }
  }

  history.log(location.pathname, document.title);

  if (currentSpaceId.value) {
    extensions.init(currentSpaceId.value).catch(console.error);
  }
});

onUnmounted(() => {
  if (!isServer) {
    document.removeEventListener("click", handleDocumentClick);
  }
});

// Redirect /spaceId/... → /spaceSlug/... once the space resolves.
watch(currentSpace, (space) => {
  if (!space) return;
  const urlSegment = router.currentRoute.value.params.spaceSlug as string;
  if (!urlSegment || urlSegment === space.slug) return;
  const fullPath = router.currentRoute.value.fullPath;
  router.replace(`/${space.slug}${fullPath.slice(urlSegment.length + 1)}`);
}, { immediate: true });

watch(currentSpaceId, (newSpaceId) => {
  if (newSpaceId) {
    extensions.init(newSpaceId).catch(console.error);
  }
});
</script>

<template>
  <div id="root" class="mx-auto relative origin-top">
    <div class="main-content min-h-screen h-full transition-all md:transition-none relative">
      <MobileHeader
        :spaceSlug="currentSpace?.slug ?? ''"
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

    <Sidebar />
  </div>

  <ClientOnly>
    <CalDAVSetupDialog />
    <ToastContainer />
    <DocumentOverlay />
    <AIChatPanel :documentId="documentContext.documentId ?? ''" />
    <CommandPalatte />
  </ClientOnly>
</template>
