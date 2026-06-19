<script setup lang="ts">
import { closeIcon, imageIcon, uploadIcon } from "~/src/assets/icons.ts";
import { ButtonSecondary, Icon } from "~/src/components/index.ts";
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
  <div
    v-if="show"
    class="fixed inset-0 z-100 flex items-center justify-center bg-black/30 backdrop-blur-sm"
    @click.self="close"
  >
    <div class="rounded-lg p-s w-full max-w-sm min-w-[280px] flex flex-col gap-3xs">
      <div class="flex items-center justify-between">
        <span class="text-size-large font-semibold text-foreground">{{ t("Header image") }}</span>
        <button class="text-foreground-secondary hover:text-foreground" @click="close">
          <Icon :icon="closeIcon" />
        </button>
      </div>

      <FileDrop :accept="HEADER_IMAGE_ACCEPT" listen-paste @select="onSelect">
        <template #default="{ isDragging }">
          <Icon
            :icon="isDragging ? uploadIcon : imageIcon"
            class="text-foreground-secondary w-8 h-8"
          />
          <p class="text-small text-foreground-secondary text-center">
            {{
              isDragging
                ? t("Drop image here")
                : t("Click to choose, drag & drop, or paste from clipboard")
            }}
          </p>
        </template>
      </FileDrop>

      <p class="text-small text-foreground-secondary text-center">
        PNG · JPEG · GIF · WebP · SVG
      </p>

      <ButtonSecondary :icon="closeIcon" :text="t('Cancel')" @click="close" />
    </div>
  </div>
</template>
