<script setup lang="ts">
import "./components/CanvasElement.ts";
import type CanvasElement from "./components/CanvasElement.ts";
import { onMounted, ref } from "vue";
import { createYProvider } from "../utils/sync.ts";
import { useDocument } from "../composeables/useDocument.ts";

const canvasRef = ref<CanvasElement>();

const props = defineProps<{
  spaceId: string;
  documentId?: string;
}>();

const { saveDocument } = useDocument(props.documentId, "canvas");

async function manualSave() {
  const canvas = canvasRef.value?.canvas;

  if (canvas) {
    const content = canvas.toString();
    await saveDocument(content);
  }
}

onMounted(() => {
  const canvas = canvasRef.value?.canvas;

  if (canvas) {
    const roomName = `${props.spaceId}:${props.documentId || crypto.randomUUID()}`;
    const provider = createYProvider(roomName, canvas.doc);
  }

  setInterval(() => manualSave(), 5000);
});
</script>

<template>
    <div class="w-full h-full relative overflow-hidden">
        <canvas-element ref="canvasRef" class="block w-full h-full relative"></canvas-element>
    </div>
</template>
