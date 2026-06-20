<script setup lang="ts">
import { computed } from "vue";
import { useDocument } from "../composeables/useDocument.ts";
import { withTransformParams } from "../files/transformUrl.ts";

const props = defineProps<{ documentId: string }>();

const { document } = useDocument(props.documentId);

const src = computed(() => {
  const url = document.value?.properties?.headerImage;
  return url ? withTransformParams(url, { w: 1600, format: "webp", q: 85 }) : null;
});
</script>

<template>
  <div v-if="src" class="print:px-0 px-xs lg:px-xl mt-4">
    <img :src="src" alt="" class="w-full h-[240px] object-cover rounded-lg" />
  </div>
</template>
