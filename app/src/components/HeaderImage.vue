<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useDocument } from "#composeables/useDocument.ts";
import { uploadingDocumentId } from "#composeables/useHeaderImage.ts";
import { withTransformParams } from "#files/transformUrl.ts";

const props = defineProps<{
  documentId: string;
  initialSrc?: string | null;
  /**
   * Layout orientation, derived from the image aspect ratio by the parent.
   * "portrait" renders a narrow column sized by `aspectRatio`; "landscape"
   * (default) keeps the full-width banner.
   */
  orientation?: "landscape" | "portrait";
  /** Aspect ratio (width / height) used to size the portrait column. */
  aspectRatio?: number | null;
}>();

const isPortrait = computed(() => props.orientation === "portrait");
const aspectStyle = computed(() =>
  isPortrait.value && props.aspectRatio && props.aspectRatio > 0
    ? { aspectRatio: String(props.aspectRatio) }
    : undefined,
);

const { document, isLoading } = useDocument(props.documentId);

const src = computed(() => {
  const headerImage = document.value?.properties?.headerImage;
  const url = Array.isArray(headerImage)
    ? headerImage[0]
    : (headerImage ?? props.initialSrc);
  return url ? withTransformParams(url, { w: 1600, format: "webp", q: 85 }) : null;
});

const isMounted = ref(false);
onMounted(() => {
  isMounted.value = true;
});

const isUploadingHeader = computed(() => uploadingDocumentId.value === props.documentId);
const showSkeleton = computed(
  () =>
    isMounted.value &&
    (isUploadingHeader.value || (isLoading.value && !!props.initialSrc)),
);
</script>

<template>
  <div v-if="src || showSkeleton" :class="isPortrait ? '' : 'print:px-0 px-xs md:px-xl'">
    <div
      v-if="showSkeleton && !src"
      :class="isPortrait
        ? 'w-full rounded-lg animate-pulse bg-neutral-50'
        : 'w-full h-[240px] rounded-lg animate-pulse bg-neutral-50'"
      :style="aspectStyle"
    />
    <img
      v-if="src"
      :src="src"
      alt=""
      :class="isPortrait
        ? 'w-full h-auto object-cover rounded-lg'
        : 'w-full h-[240px] object-cover rounded-lg'"
      :style="aspectStyle"
    >
  </div>
</template>
