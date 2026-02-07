<script setup lang="ts">
import DocumentTree from "./DocumentTree.vue";
import NewDocumentButton from "./NewDocumentButton.vue";
import { computed, ref, Teleport, onMounted, onUnmounted } from "vue";
import { SpaceSelector, MenuLink } from "~/src/components/index.ts";
import { homeIcon, searchIcon, folderIcon, puzzleIcon } from "~/src/assets/icons.ts";
import { useSpace, type Space as ApiSpace } from "../composeables/useSpace.ts";
import { canAccessSettings, canEdit } from "../composeables/usePermissions.ts";
import CreateSpaceDialog from "./CreateSpaceDialog.vue";
import { extensions } from "../utils/extensions.ts";
import { useRoute } from "../composeables/useRoute.ts";

// UI-specific Space interface for the selector component
interface UiSpace {
  id: string;
  name: string;
  members?: number;
  color?: string;
  logoSvg?: string;
}

const { pathname, spaceSlug } = useRoute();

const { currentSpace, spaces, setCurrentSpace, createSpace, isLoading: spaceIsLoading } = useSpace();

const showCreateDialog = ref(false);

const activeRoute = computed(() => {
  let activeRoute = "";

  // Determine active route
  if (pathname.value.includes("/search")) {
    activeRoute = "search";
  } else if (pathname.value.includes("/drafts")) {
    activeRoute = "drafts";
  } else if (pathname.value.includes("/archive")) {
    activeRoute = "archive";
  } else if (pathname.value.includes("/x/")) {
    // Extension route - extract the path after /x/
    const match = pathname.value.match(/\/x\/(.+)/);
    activeRoute = match ? `x/${match[1]}` : "";
  } else if (pathname.value.split("/").filter(Boolean).length === 1) {
    activeRoute = "home";
  }

  return activeRoute;
});

// Extension menu links (from routes with menuItem defined)
const extensionMenuLinks = ref<Array<{ extensionId: string; route: string; title: string; icon?: string }>>([]);

function updateExtensionMenuLinks() {
  extensionMenuLinks.value = extensions.getMenuLinks();
}

const isLoading = computed(() => {
  return !pathname.value || spaceIsLoading.value;
});

onMounted(() => {
  // Update menu links when extensions finish loading
  updateExtensionMenuLinks();

  // Listen for extension changes
  window.addEventListener("extensions:loaded", updateExtensionMenuLinks);
});

onUnmounted(() => {
  window.removeEventListener("extensions:loaded", updateExtensionMenuLinks);
});

// Transform app spaces to UI library Space format
const uiSpaces = computed<UiSpace[]>(() => {
  if (!spaces.value) return [];

  return spaces.value.map((space: ApiSpace) => ({
    id: space.id,
    name: space.name,
    members: space.memberCount,
    color: space.preferences?.brandColor,
    logoSvg: space.preferences?.logoSvg,
  }));
});

// Check if current user can access settings
const userCanAccessSettings = computed(() => {
  return canAccessSettings(currentSpace.value?.userRole);
});

// Check if current user can edit (editors and owners can see drafts/archive)
const userCanEdit = computed(() => {
  return canEdit(currentSpace.value?.userRole);
});

const handleSpaceSelect = (space: UiSpace) => {
  const fullSpace = spaces.value?.find((s: ApiSpace) => s.id === space.id);
  if (fullSpace) {
    setCurrentSpace(fullSpace);
    // Navigate to the selected space
    window.location.href = `/${fullSpace.slug}`;
  }
};

const handleSettings = () => {
  if (currentSpace.value) {
    window.location.href = `/${currentSpace.value.slug}/settings`;
  }
};

const handleCreateClick = () => {
  showCreateDialog.value = true;
};

const handleCreateSpace = async (data: {
  name: string;
  slug: string;
  brandColor: string;
}) => {
  try {
    const newSpace = await createSpace(data.name, data.slug, {
      brandColor: data.brandColor,
    });
    // Navigate to the new space
    window.location.href = `/${newSpace.slug}`;
  } catch (err) {
    console.error("Failed to create space:", err);
  }
};

const handleCreateDoc = () => {
  Actions.run("document:create");
};

Actions.register("document:create", {
  title: "Create Document",
  description: "Create a new document",
  run: async () => {
    if (currentSpace.value) {
      window.location.href = `/${currentSpace.value.slug}/new`;
    }
  },
});

Actions.register("find:open", {
  title: "Find",
  description: "Open find document dialog",
  run: async () => {
    if (currentSpace.value) {
      window.location.href = `/${currentSpace.value.slug}/search`;
    }
  },
});

Actions.mapShortcut("meta-shift-f", "find:open");
</script>

<template>
  <nav class="@container flex flex-col gap-4xs">
    <!-- Space Selector -->
    <div class="px-5xs py-4xs flex-none sticky top-0 bg-background z-10">
      <SpaceSelector
        :spaces="uiSpaces"
        :model-value="currentSpace?.id || null"
        :can-access-settings="userCanAccessSettings"
        :can-create-docs="userCanEdit"
        @select="handleSpaceSelect"
        @settings="handleSettings"
        @create="handleCreateClick"
        @create-doc="handleCreateDoc"
      />

      <Teleport to="#root">
        <CreateSpaceDialog v-model:show="showCreateDialog" @create="handleCreateSpace" />
      </Teleport>
    </div>

    <div v-if="isLoading" class="px-3xs flex-none hidden lg:flex flex-col gap-1">
      <div v-for="i in 3" :key="`nav-skeleton-${i}`" class="h-9 bg-neutral-100 rounded-md animate-pulse" />
    </div>

    <div v-if="!isLoading" class="px-3xs flex-none hidden lg:flex flex-col gap-1">
        <MenuLink
            :icon="homeIcon"
            text="Home"
            :href="`/${spaceSlug}/`"
            :is-active="activeRoute === 'home'"
        />
        <MenuLink
            :icon="searchIcon"
            text="Find"
            :href="`/${spaceSlug}/search`"
            :is-active="activeRoute === 'search'"
        >
            <a-shortcut class="ml-6 flex-none @max-xs:hidden!" data-shortcut="cmd-shift-f"></a-shortcut>
        </MenuLink>
        <MenuLink
            v-if="userCanEdit"
            :icon="folderIcon"
            text="Archive"
            :href="`/${spaceSlug}/archive`"
            :is-active="activeRoute === 'archive'"
        />
    </div>

    <!-- Extension Menu Links -->
    <div v-if="extensionMenuLinks.length > 0 && !isLoading" class="px-3xs flex-none flex flex-col gap-1.5">
        <MenuLink
            v-for="link in extensionMenuLinks"
            :key="`${link.extensionId}-${link.route}`"
            :icon="link.icon || puzzleIcon"
            :text="link.title"
            :href="`/${spaceSlug}/x/${link.route}`"
            :is-active="activeRoute === `x/${link.route}`"
        />
    </div>

    <!-- Document Tree -->
    <div class="@max-xs:invisible px-5xs py-m">
      <div v-if="isLoading" class="px-2 space-y-1 hidden lg:flex flex-col">
        <!-- Category skeleton -->
        <div v-for="i in 3" :key="`cat-skeleton-${i}`" class="space-y-1">
          <!-- Category header -->
          <div class="flex items-center gap-2 p-2 rounded-md">
            <div class="w-4 h-4 bg-neutral-200 rounded animate-pulse flex-none" />
            <div class="w-6 h-6 bg-neutral-200 rounded flex-none animate-pulse" />
            <div class="h-4 bg-neutral-200 rounded w-24 animate-pulse" />
          </div>
          <!-- Documents under category -->
          <div class="pl-4 space-y-1">
            <div v-for="j in 2" :key="`doc-skeleton-${i}-${j}`" class="flex items-center gap-2 p-2 rounded-md">
              <div class="w-4 h-4 bg-neutral-200 rounded animate-pulse flex-none" />
              <div class="h-3 bg-neutral-200 rounded w-32 animate-pulse flex-1" />
            </div>
          </div>
        </div>
      </div>

      <DocumentTree v-if="!isLoading" />
    </div>
  </nav>
</template>
