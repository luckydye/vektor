<script setup lang="ts">
import { useToast } from "#composeables/useToast.ts";
import { alertCircleIcon, checkCircleOutlineIcon, infoIcon } from "~/src/assets/icons.ts";

const { toasts } = useToast();

const icons = {
  error: alertCircleIcon,
  success: checkCircleOutlineIcon,
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
          class="relative overflow-hidden flex items-center gap-2.5 px-4 py-2.5 rounded-lg shadow-large text-size-small font-medium pointer-events-auto min-w-64"
          :class="{
            'bg-red-600 text-white': toast.type === 'error',
            'bg-neutral-900 text-white': toast.type === 'info',
            'bg-green-600 text-white': toast.type === 'success',
          }"
        >
          <div class="svg-icon w-4 h-4 shrink-0" v-html="icons[toast.type]" />
          <span class="relative z-10">{{ toast.message }}</span>
          <div
            v-if="toast.progress !== undefined"
            class="absolute inset-x-0 bottom-0 h-1 bg-white/15"
          >
            <div
              class="h-full bg-white/55 transition-all duration-200 ease-out"
              :style="{ width: `${Math.max(0, Math.min(1, toast.progress)) * 100}%` }"
            />
          </div>
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
