<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { withTransformParams } from "../files/transforms.ts";

const props = defineProps<{ initialSrc?: string; documentType?: string }>();

const src = ref(props.initialSrc ?? null);

function applyTransform(url: string): string {
  return withTransformParams(url, { w: 1600, format: "webp", q: 85 });
}

function onPropertyChange(e: Event) {
  const { propertyName, value } = (e as CustomEvent<{ propertyName: string; value: string }>).detail;
  if (propertyName === "headerImage") {
    src.value = value ? applyTransform(value) : null;
  }
}

onMounted(() => window.addEventListener("document:property", onPropertyChange));
onUnmounted(() => window.removeEventListener("document:property", onPropertyChange));
</script>

<template>
  <div v-if="src" class="print:px-0 px-xs lg:px-xl mt-4">
    <img :src="src" alt="" class="w-full h-[240px] object-cover rounded-lg" />
  </div>
</template>
