<script setup lang="ts">
import { getCurrentInstance, onMounted, watch } from "vue";
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
import SpaceHomeView from "./views/SpaceHomeView.vue";
import SpaceSearchView from "./views/SpaceSearchView.vue";
import SpaceSettingsView from "./views/SpaceSettingsView.vue";
import { useDocumentContext } from "../composeables/useDocument.ts";
import { useRoute } from "../composeables/useRoute.ts";
import { useSpace } from "../composeables/useSpace.ts";
import strings from "../config/strings.json";
import { Actions } from "../utils/actions.js";
import shortcuts from "../config/shortcuts.json";
import { extensions } from "../utils/extensions.ts";
import { history } from "../utils/history.ts";
import { initInsets } from "../utils/insets.ts";

const props = defineProps<{ url?: string }>();

const isServer = typeof window === "undefined";

const router = createRouter({
  history: isServer ? createMemoryHistory(props.url ?? "/") : createWebHistory(),
  routes: [
    { path: "/:spaceSlug", component: SpaceHomeView },
    { path: "/:spaceSlug/search", component: SpaceSearchView },
    { path: "/:spaceSlug/new", component: NewDocumentView },
    { path: "/:spaceSlug/settings", component: SpaceSettingsView },
    { path: "/:spaceSlug/doc/:documentSlug(.*)", component: DocumentPageView, props: true },
    { path: "/:spaceSlug/x/:pathMatch(.*)*", component: ExtensionRouteView },
    { path: "/:spaceSlug/rev/:id", redirect: (to) => `/${to.params.spaceSlug}` },
  ],
});

if (!isServer) {
  router.afterEach((to) => {
    history.log(to.fullPath, document.title);
    document.dispatchEvent(new Event("astro:page-load"));
  });
}

const instance = getCurrentInstance();
if (instance) {
  instance.appContext.app.use(router);
}

const { pathname } = useRoute();
const { currentSpaceId, currentSpace } = useSpace();
const { documentContext } = useDocumentContext();

const lang = typeof document !== "undefined" ? document.documentElement.lang || "en" : "en";
globalThis._translations = strings;

onMounted(async () => {
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

      <RouterView />
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
