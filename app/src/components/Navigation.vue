<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, Teleport, watch } from "vue";
import {
  boltIcon,
  checkThinIcon,
  homeIcon,
  pencilIcon,
  puzzleIcon,
  searchIcon,
  settingsIcon,
} from "~/src/assets/icons.ts";
import { MenuLink, SpaceSelector } from "~/src/components/index.ts";
import { canAccessSettings, canEdit } from "../composeables/usePermissions.ts";
import { useRoute } from "../composeables/useRoute.ts";
import { type Space as ApiSpace, useSpace } from "../composeables/useSpace.ts";
import { Actions } from "../utils/actions.ts";
import { extensions } from "../utils/extensions.ts";
import { t } from "../utils/lang.ts";
import CreateSpaceDialog from "./CreateSpaceDialog.vue";
import DocumentTree from "./DocumentTree.vue";
import NewDocumentButton from "./NewDocumentButton.vue";

// UI-specific Space interface for the selector component
interface UiSpace {
  id: string;
  name: string;
  members?: number;
  color?: string;
  logoSvg?: string;
}

const { pathname, spaceSlug } = useRoute();

const {
  currentSpace,
  spaces,
  setCurrentSpace,
  createSpace,
  isLoading: spaceIsLoading,
} = useSpace();

const showCreateDialog = ref(false);
const documentTree = ref<InstanceType<typeof DocumentTree> | null>(null);

const activeRoute = computed(() => {
  let activeRoute = "";

  // Determine active route
  if (pathname.value.includes("/search")) {
    activeRoute = "search";
  } else if (pathname.value.includes("/x/")) {
    // Extension route - extract the path after /x/
    const match = pathname.value.match(/\/x\/(.+)/);
    activeRoute = match ? `x/${match[1]}` : "";
  } else if (pathname.value.includes("/settings")) {
    activeRoute = "settings";
  } else if (pathname.value.split("/").filter(Boolean).length === 1) {
    activeRoute = "home";
  }

  return activeRoute;
});

// Extension menu links (from routes with menuItem defined)
const extensionMenuLinks = ref<
  Array<{ extensionId: string; route: string; title: string; icon?: string }>
>([]);

function updateExtensionMenuLinks() {
  extensionMenuLinks.value = extensions.getMenuLinks();
}

const isLoading = computed(() => {
  return !pathname.value || spaceIsLoading.value;
});

const hasEverLoaded = ref(false);
watch(
  isLoading,
  (loading) => {
    if (!loading) hasEverLoaded.value = true;
  },
  { immediate: true },
);

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

// Check if current user can edit
const userCanEdit = computed(() => {
  if (isLoading.value) {
    return false;
  }
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
  title: t("Create Document"),
  description: t("Create a new document"),
  run: async () => {
    if (currentSpace.value) {
      window.location.href = `/${currentSpace.value.slug}/new`;
    }
  },
});

Actions.register("find:open", {
  title: t("Find"),
  description: t("Open find document dialog"),
  run: async () => {
    if (currentSpace.value) {
      window.location.href = `/${currentSpace.value.slug}/search`;
    }
  },
});

Actions.mapShortcut("meta-shift-f", "find:open");
</script>

<template>
  <nav class="@container flex flex-col gap-3xs">
    <CreateSpaceDialog v-model:show="showCreateDialog" @create="handleCreateSpace" />
    
    <!-- Space Selector -->
    <div class="px-4xs py-4xs flex-none sticky top-0 bg-background z-10 border-b border-neutral-100 rounded-t-md">
      <SpaceSelector
        :spaces="uiSpaces"
        :model-value="currentSpace?.id"
        :can-create-docs="userCanEdit"
        :loading="isLoading"
        @select="handleSpaceSelect"
        @create="handleCreateClick"
        @create-doc="handleCreateDoc"
      />
    </div>

    <div class="px-4xs flex-none flex flex-col gap-0.5">
        <div class="flex items-center gap-px">
          <MenuLink
              class="flex-1"
              :icon="homeIcon"
              :text="t('Home')"
              :href="`/${spaceSlug}/`"
              :is-active="activeRoute === 'home'"
          />
          <button
              class="@max-sm:hidden inline-flex items-center justify-center rounded-md text-neutral-800 transition-colors hover:transition-none hover:bg-primary-50 active:bg-primary-100 cursor-pointer flex-none w-9 min-h-[36px]"
              :title="t('Command Palette')"
              @click="Actions.run('ui:toggle:palatte')"
          >
              <span v-html="boltIcon" class="icon inline flex-none" />
          </button>
        </div>
        <MenuLink
            v-if="userCanAccessSettings"
            :icon="settingsIcon"
            :text="t('Settings')"
            :href="`/${spaceSlug}/settings`"
            :is-active="activeRoute === 'settings'"
        />
        <MenuLink
            :icon="searchIcon"
            :text="t('Find')"
            :href="`/${spaceSlug}/search`"
            :is-active="activeRoute === 'search'"
        >
            <a-shortcut class="ml-6 flex-none @max-xs:hidden!" data-shortcut="cmd-shift-f"></a-shortcut>
        </MenuLink>
    </div>

    <!-- Extension Menu Links -->
    <div v-if="extensionMenuLinks.length > 0 && !isLoading" class="px-4xs flex-none flex flex-col gap-0.5">
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
      <div class="flex items-center justify-between gap-3xs px-4xs mb-2">
        <h3 class="text-size-small font-medium text-neutral-900 uppercase tracking-wider opacity-50">{{ t('Categories') }}</h3>
        <button
          v-if="documentTree"
          @click="documentTree.toggleEditMode()"
          class="p-1 text-neutral-900 hover:text-neutral rounded-sm transition-colors"
          :title="documentTree.isEditMode ? 'Done editing' : 'Edit categories'"
        >
          <div v-if="!documentTree.isEditMode" class="svg-icon w-4 h-4" v-html="pencilIcon" />
          <div v-else class="svg-icon w-4 h-4" v-html="checkThinIcon" />
        </button>
      </div>
      <div v-if="isLoading && !hasEverLoaded" class="px-5xs space-y-1 hidden lg:flex flex-col">
        <!-- Category skeleton -->
        <div v-for="i in 3" :key="`cat-skeleton-${i}`" class="space-y-1">
          <!-- Category header -->
          <div class="flex items-center gap-2 p-2 rounded-md">
            <div class="w-6 h-6 bg-neutral-200 rounded-sm flex-none animate-pulse" />
            <div class="h-4 bg-neutral-200 rounded-sm w-24 animate-pulse" />
          </div>
          <!-- Documents under category -->
          <div class="pl-3 space-y-1">
            <div v-for="j in 2" :key="`doc-skeleton-${i}-${j}`" class="flex items-center gap-2 p-2 rounded-md">
              <div class="w-4 h-4 bg-neutral-200 rounded-sm animate-pulse flex-none" />
              <div class="h-3 bg-neutral-200 rounded-sm w-32 animate-pulse flex-1" />
            </div>
          </div>
        </div>
      </div>

      <DocumentTree ref="documentTree" v-show="!isLoading" />
    </div>
  </nav>
</template>
