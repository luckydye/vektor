<script setup lang="ts">
import { ref, watch } from "vue";
import { extensions, type ExtensionViewElement } from "../utils/extensions.ts";
import DockedPanel from "./DockedPanel.vue";
import { useDockedWindows } from "../composeables/useDockedWindows.ts";

const VIEW_PATH = "workflow-builder";

const props = defineProps<{
  documentId: string;
  spaceId: string;
}>();

const { windows } = useDockedWindows();

const containerRef = ref<ExtensionViewElement>();
const mounted = ref(false);
const error = ref<string | null>(null);

async function mountExtension() {
  if (mounted.value || !containerRef.value?.root) return;
  mounted.value = true;

  window.location.hash = `#/edit/${props.documentId}`;

  await extensions.init(props.spaceId);

  const ok = await extensions.renderView(VIEW_PATH, VIEW_PATH, containerRef.value.root);
  if (!ok) {
    error.value = "Workflow editor extension is not installed.";
    return;
  }

  if (containerRef.value.shadowRoot) {
    const style = document.createElement("style");
    style.textContent = `.pointer-events-none.absolute.right-3.bottom-3 { display: none !important; }`;
    containerRef.value.shadowRoot.appendChild(style);
  }
}

// Mount once the panel becomes open and the container is available
watch(
  [() => windows.value.get("workflow-editor")?.open, containerRef],
  ([open]) => {
    if (open) mountExtension();
    if (!open) window.location.hash = "";
  },
);
</script>

<template>
  <DockedPanel
    id="workflow-editor"
    title="Workflow Editor"
    default-side="right"
    :default-width="720"
    default-mode="floating"
  >
    <div class="flex flex-col h-full bg-white">
      <div v-if="error" class="flex items-center justify-center h-full text-sm text-red-500">
        {{ error }}
      </div>
      <extension-view ref="containerRef" class="flex-1 w-full h-full" />
    </div>
  </DockedPanel>
</template>
