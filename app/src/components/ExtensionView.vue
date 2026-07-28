<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { type ExtensionViewElement, extensions } from "#extensions/manager.ts";

const props = withDefaults(
  defineProps<{
    extensionId: string;
    routePath: string;
    spaceId: string;
    fill?: boolean;
  }>(),
  {
    fill: false,
  },
);

const containerRef = ref<ExtensionViewElement>();
const error = ref<string | null>(null);
const loading = ref(true);
let cleanup: (() => void) | null = null;
let renderVersion = 0;

function cleanupView() {
  if (cleanup) {
    try {
      cleanup();
    } catch (err) {
      console.error("Error cleaning up extension view:", err);
    }
    cleanup = null;
  }

  containerRef.value?.root?.replaceChildren();
}

async function renderView() {
  if (!containerRef.value) return;

  const version = ++renderVersion;
  cleanupView();
  loading.value = true;
  error.value = null;

  try {
    // Ensure extensions are initialised for this space
    await extensions.init(props.spaceId);
    if (version !== renderVersion) return;

    const root = containerRef.value?.root;
    if (!root) {
      throw new Error("Extension view element is missing root");
    }

    // Give each render its own mount point. An async renderer from a previous
    // route can then only mutate its detached mount point after navigation.
    const mount = document.createElement("div");
    mount.style.height = "100%";
    mount.style.width = "100%";
    root.replaceChildren(mount);

    const nextCleanup = await extensions.renderInlineView(
      props.extensionId,
      props.routePath,
      mount,
    );

    if (version !== renderVersion) {
      nextCleanup?.();
      mount.remove();
      return;
    }

    cleanup = nextCleanup;
    if (!nextCleanup) {
      error.value = `Failed to render view for route "${props.routePath}"`;
    }
  } catch (err) {
    console.error("Error rendering extension view:", err);
    if (version === renderVersion) {
      error.value = `Failed to render view for route "${props.routePath}"`;
    }
  } finally {
    if (version === renderVersion) {
      loading.value = false;
    }
  }
}

onMounted(() => {
  renderView();
});

// Re-render if props change
watch(
  () => [props.extensionId, props.routePath, props.spaceId],
  () => {
    renderView();
  },
);

onUnmounted(() => {
  renderVersion++;
  cleanupView();
});
</script>

<template>
  <div :class="['w-full', { 'relative h-full': props.fill }]">
    <div v-if="loading" class="flex items-center justify-center py-20">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
    </div>

    <div
      v-else-if="error"
      class="m-12 bg-red-50 border border-red-200 rounded-lg p-4 text-red-700"
    >
      <p class="font-medium">Extension Error</p>
      <p class="text-size-medium mt-1">{{ error }}</p>
    </div>

    <extension-view
      ref="containerRef"
      :class="[
        'block w-full',
        { 'absolute inset-0 h-full': props.fill, hidden: loading },
      ]"
    ></extension-view>
  </div>
</template>

<style>
extension-view {
  display: block;
}
</style>
