<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import { extensions, type ExtensionViewElement } from "../utils/extensions.ts";
import { twMerge } from "tailwind-merge";

const props = defineProps<{
  extensionId: string;
  routePath: string;
  spaceId: string;
}>();

const containerRef = ref<ExtensionViewElement>();
const error = ref<string | null>(null);
const loading = ref(true);

async function renderView() {
  if (!containerRef.value) return;

  loading.value = true;
  error.value = null;

  // Clear container
  containerRef.value.innerHTML = "";

  // Ensure extensions are initialised for this space
  await extensions.init(props.spaceId);

  if (!containerRef.value?.root) {
    throw new Error("Extension view element is missing root");
  }

  // Render the view
  const success = await extensions.renderView(
    props.extensionId,
    props.routePath,
    containerRef.value?.root,
  );

  if (!success) {
    error.value = `Failed to render view for route "${props.routePath}"`;
  }

  loading.value = false;
}

onMounted(() => {
  renderView();
});

// Re-render if props change
watch(
  () => [props.extensionId, props.routePath, props.spaceId, containerRef.value?.root],
  () => {
    renderView();
  },
);

onUnmounted(() => {
  // Cleanup is handled by the extensions manager
});
</script>

<template>
  <div>
    <div v-if="loading" class="flex items-center justify-center py-20">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
    </div>

    <div
      v-else-if="error"
      class="m-12 bg-red-50 border border-red-200 rounded-lg p-4 text-red-700"
    >
      <p class="font-medium">Extension Error</p>
      <p class="text-sm mt-1">{{ error }}</p>
    </div>

    <extension-view ref="containerRef" :class="twMerge(loading && 'hidden')"></extension-view>
  </div>
</template>

<style>
extension-view {
    height: 100%;
    width: 100%;
    position: absolute;
    top: 0;
    left: 1rem;
}
</style>