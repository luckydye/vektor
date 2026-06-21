<script setup lang="ts">
import { computed } from "vue";
import { useDocument } from "../composeables/useDocument.ts";
import { uploadingDocumentId } from "../composeables/useHeaderImage.ts";
import { withTransformParams } from "../files/transformUrl.ts";

const props = defineProps<{ documentId: string; initialSrc?: string | null }>();

const { document, isLoading } = useDocument(props.documentId);

const src = computed(() => {
  const url = document.value?.properties?.headerImage ?? props.initialSrc;
  return url ? withTransformParams(url, { w: 1600, format: "webp", q: 85 }) : null;
});

const isUploadingHeader = computed(() => uploadingDocumentId.value === props.documentId);
const showSkeleton = computed(() => isLoading.value || isUploadingHeader.value);
</script>

<template>
  <div v-if="src || showSkeleton" class="print:px-0 px-xs lg:px-xl mt-4">
    <div v-if="showSkeleton && !src" class="w-full h-[240px] rounded-lg animate-pulse bg-neutral-50" />
    <img
      v-if="src"
      :src="src"
      alt=""
      class="w-full h-[240px] object-cover rounded-lg"
    />
  </div>
</template>
