<script setup lang="ts">
import { alertCircleIcon, checkCircleIcon, infoIcon } from "~/src/assets/icons.ts";
import { useToast } from "../composeables/useToast.ts";

const { toasts } = useToast();

const icons = {
  error: alertCircleIcon,
  success: checkCircleIcon,
  info: infoIcon,
};
</script>

<template>
  <Teleport to="body">
    <div class="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-2 pointer-events-none">
      <TransitionGroup name="toast">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="flex items-center gap-2.5 px-4 py-2.5 rounded-lg shadow-large text-size-small font-medium pointer-events-auto"
          :class="{
            'bg-red-600 text-white': toast.type === 'error',
            'bg-neutral-900 text-white': toast.type === 'info',
            'bg-green-600 text-white': toast.type === 'success',
          }"
        >
          <div class="svg-icon w-4 h-4 shrink-0" v-html="icons[toast.type]" />
          {{ toast.message }}
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
