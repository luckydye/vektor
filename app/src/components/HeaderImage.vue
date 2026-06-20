<script setup lang="ts">
import { computed, ref } from "vue";
import { useDocument } from "../composeables/useDocument.ts";
import { withTransformParams } from "../files/transformUrl.ts";

const props = defineProps<{ documentId: string }>();

const { document, isLoading } = useDocument(props.documentId);

const src = computed(() => {
  const url = document.value?.properties?.headerImage;
  return url ? withTransformParams(url, { w: 1600, format: "webp", q: 85 }) : null;
});
</script>

<template>
  <div class="print:px-0 px-xs lg:px-xl mt-4">
    <div v-if="!src || isLoading" class="w-full h-[240px] rounded-lg animate-pulse bg-neutral-50" />
    <img
      v-if="src"
      :src="src"
      alt=""
      class="w-full h-[240px] object-cover rounded-lg"
    />
  </div>
</template>
