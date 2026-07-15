<script setup lang="ts">
import { computed } from "vue";
import ChevronDownIcon from "#assets/icons/chevron-down.svg?raw";

interface Props {
  variant?: "default" | "with-context";
  tone?: "primary" | "danger";
  text?: string;
  icon?: string;
  shortcut?: string;
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  variant: "default",
  tone: "primary",
});

const emit = defineEmits<{
  click: [event: MouseEvent];
}>();

const showContextMenu = computed(() => props.variant === "with-context");

const handleClick = (event: MouseEvent) => {
  emit("click", event);
};
</script>

<template>
  <button
    type="button"
    class="button-primary"
    :class="{
        'px-3xs': !showContextMenu,
        'pl-3xs': showContextMenu,
        '!border-red-600 !bg-red-600 enabled:hover:!bg-red-700 enabled:active:!bg-red-800': tone === 'danger',
      }"
    :disabled="disabled"
    @click="handleClick"
  >
    <div class="inline-flex justify-center items-center">
      <slot />
      <div v-if="icon" v-html="icon" class="icon" />
      <span class="empty:hidden">{{ text }}</span>
    </div>
    <div
      v-if="showContextMenu"
      class="flex items-center justify-center w-[36px] h-[34px] border-l border-primary-700 pl-3xs pr-3xs"
    >
      <div v-html="ChevronDownIcon" />
    </div>
    <div v-if="shortcut">
      <a-shortcut :data-shortcut="shortcut"></a-shortcut>
    </div>
  </button>
</template>
