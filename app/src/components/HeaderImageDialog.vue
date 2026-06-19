<script setup lang="ts">
import { Icon } from "~/src/components/index.ts";
import { t } from "../utils/lang.ts";
import FileDrop from "./FileDrop.vue";

const HEADER_IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";

defineProps<{ show?: boolean }>();

const emit = defineEmits<{
  "update:show": [value: boolean];
  select: [file: File];
}>();

function close() {
  emit("update:show", false);
}

function onSelect(file: File) {
  emit("select", file);
  close();
}
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="show"
        class="fixed inset-0 z-100 flex items-center justify-center bg-black/30 backdrop-blur-sm p-m"
        @click.self="close"
      >
        <div class="bg-background rounded-2xl shadow-large w-full max-w-md flex flex-col gap-s p-m">
          <div class="flex flex-col items-center gap-5xs text-center">
            <h2 class="text-size-title font-semibold text-neutral-900">{{ t("Header image") }}</h2>
            <p class="text-small text-neutral-400">{{ t("Upload an image for this document") }}</p>
          </div>

          <FileDrop
            :accept="HEADER_IMAGE_ACCEPT"
            hint="PNG · JPEG · GIF · WebP · SVG"
            listen-paste
            @select="onSelect"
          >
            <template #default="{ isDragging, openPicker }">
              <div
                class="flex items-center justify-center w-14 h-14 rounded-full transition-colors"
                :class="isDragging ? 'bg-primary-100' : 'bg-primary-50'"
              >
                <Icon name="upload" class="w-7 h-7 text-primary-500" />
              </div>

              <p class="text-size-normal text-neutral-700 text-center">
                {{ t("Drag & drop here or") }}
                <button
                  type="button"
                  class="text-primary-500 hover:text-primary-600 font-medium hover:underline underline-offset-2 cursor-pointer"
                  @click.stop="openPicker"
                >
                  {{ t("choose file") }}
                </button>
              </p>

              <p class="text-small text-neutral-400 text-center -mt-1">
                PNG · JPEG · GIF · WebP · SVG
              </p>
            </template>
          </FileDrop>

          <button
            type="button"
            class="text-small text-neutral-400 hover:text-neutral-600 text-center transition-colors"
            @click="close"
          >
            {{ t("Cancel") }}
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
