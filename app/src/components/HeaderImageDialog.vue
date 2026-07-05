<script setup lang="ts">
import { ref, watch } from "vue";
import "@atrium-ui/elements/popover";
import { Icon } from "~/src/components/index.ts";
import { t } from "#utils/lang.ts";
import FileDrop from "./FileDrop.vue";

const HEADER_IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";

const props = defineProps<{ show?: boolean }>();

const emit = defineEmits<{
  "update:show": [value: boolean];
  select: [file: File];
}>();

const triggerRef = ref<HTMLButtonElement | null>(null);

watch(
  () => props.show,
  (val) => {
    if (val) triggerRef.value?.click();
  },
);

const cancelRef = ref<HTMLButtonElement | null>(null);

function close() {
  cancelRef.value?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
}

function onExit() {
  emit("update:show", false);
}

function onSelect(file: File) {
  emit("select", file);
  close();
}
</script>

<template>
  <a-popover-trigger class="group absolute left-0 top-0 w-0 h-0 overflow-hidden">
    <!-- Zero-size anchor; clicked programmatically to open the popover -->
    <button
      ref="triggerRef"
      slot="trigger"
      type="button"
      class="w-0 h-0 block overflow-hidden"
      aria-hidden="true"
      tabindex="-1"
    />

    <a-popover class="group" placements="bottom-end" @exit="onExit">
      <div class="w-max opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
        <div
          class="bg-background border border-neutral-100 rounded-2xl shadow-large w-[400px] p-m origin-top-right scale-95 transition-all duration-150 group-[&[enabled]]:scale-100"
        >
          <div class="flex flex-col gap-s">
            <div class="flex flex-col items-center gap-5xs text-center">
              <h2 class="text-size-large font-semibold text-neutral-900">{{ t("Header image") }}</h2>
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
              ref="cancelRef"
              type="button"
              class="text-small text-neutral-400 hover:text-neutral-600 text-center transition-colors"
              @click="close"
            >
              {{ t("Cancel") }}
            </button>
          </div>
        </div>
      </div>
    </a-popover>
  </a-popover-trigger>
</template>
