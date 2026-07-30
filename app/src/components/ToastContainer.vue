<script setup lang="ts">
import { ref, watch } from "vue";
import { type Toast, useToast } from "#composeables/useToast.ts";
import { animateIn, animateOut, EXIT_TIMEOUT_MS } from "#utils/animate.ts";
import { alertCircleIcon, confirmationIcon, infoIcon } from "~/src/assets/icons.ts";

const { toasts, drop } = useToast();
const elements = new Map<number, HTMLElement>();
const exiting = new Set<number>();

function registerToast(id: number, el: unknown) {
  if (el instanceof HTMLElement) {
    elements.set(id, el);
    animateIn(el);
  } else {
    elements.delete(id);
  }
}

/**
 * Play a toast out and then remove it.
 *
 * The removal must happen whatever the animation does, so it is raced against a
 * timer: a background tab throttles rAF, and `animateOut` would then resolve
 * far too late (or not until the tab is focused again), pinning the toast.
 */
async function playOutAndDrop(id: number) {
  if (exiting.has(id)) return;
  exiting.add(id);

  const el = elements.get(id);
  await Promise.race([
    el ? animateOut(el) : Promise.resolve(),
    new Promise((resolve) => setTimeout(resolve, EXIT_TIMEOUT_MS)),
  ]);

  exiting.delete(id);
  elements.delete(id);
  drop(id);
}

watch(
  toasts,
  (currentToasts) => {
    for (const toast of currentToasts) {
      if (toast.exiting) void playOutAndDrop(toast.id);
    }
  },
  { deep: true },
);
const completedActions = ref<Set<number>>(new Set());

const icons = {
  error: alertCircleIcon,
  success: confirmationIcon,
  info: infoIcon,
};

watch(toasts, (currentToasts) => {
  const currentIds = new Set(currentToasts.map((toast) => toast.id));
  completedActions.value = new Set(
    [...completedActions.value].filter((id) => currentIds.has(id)),
  );
});

async function runAction(toast: Toast) {
  if (!toast.action || completedActions.value.has(toast.id)) return;
  try {
    await toast.action.run();
    completedActions.value = new Set([...completedActions.value, toast.id]);
  } catch (error) {
    console.error("Toast action failed", error);
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      id="toast-container"
      class="fixed bottom-20 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-2 pointer-events-none"
    >
      <div
        v-for="toast in toasts"
        :key="toast.id"
        :ref="(el) => registerToast(toast.id, el)"
        class="relative overflow-hidden flex items-center gap-2.5 px-4 py-2.5 rounded-lg shadow-large text-size-small font-medium pointer-events-auto min-w-64"
        :class="{
            'bg-red-600 text-white': toast.type === 'error',
            'bg-neutral-900 text-white': toast.type === 'info',
            'bg-green-600 text-white': toast.type === 'success',
          }"
      >
        <div class="svg-icon w-4 h-4 shrink-0" v-html="icons[toast.type]" />
        <span class="relative z-10">{{ toast.message }}</span>
        <button
          v-if="toast.action"
          type="button"
          class="relative z-10 ml-auto rounded-md bg-white/15 px-2 py-1 text-xs font-semibold transition-colors hover:bg-white/25"
          :disabled="completedActions.has(toast.id)"
          @click="runAction(toast)"
        >
          {{ completedActions.has(toast.id)
                ? (toast.action.completedLabel ?? toast.action.label)
                : toast.action.label }}
        </button>
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
    </div>
  </Teleport>
</template>
