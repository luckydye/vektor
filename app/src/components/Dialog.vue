<script setup lang="ts">
import { onBeforeUnmount, onMounted, useSlots, watch } from "vue";
import { closeIcon } from "~/src/assets/icons.ts";

const props = withDefaults(
  defineProps<{
    show?: boolean;
    title?: string;
    /** Close when the backdrop is clicked. */
    closeOnBackdrop?: boolean;
  }>(),
  {
    show: false,
    title: "",
    closeOnBackdrop: true,
  },
);

const emit = defineEmits<{
  "update:show": [value: boolean];
  close: [];
}>();

const slots = useSlots();

function close() {
  emit("update:show", false);
  emit("close");
}

function onBackdrop() {
  if (props.closeOnBackdrop) close();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.show) close();
}

// Lock background scroll while the dialog is open.
function setBodyScrollLock(locked: boolean) {
  if (typeof document === "undefined") return;
  document.body.style.overflow = locked ? "hidden" : "";
}

watch(
  () => props.show,
  (show) => setBodyScrollLock(show),
);

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  if (props.show) setBodyScrollLock(true);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  setBodyScrollLock(false);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div
        v-if="show"
        class="dialog-root fixed inset-0 z-100 flex items-end justify-center md:items-center"
        role="dialog"
        aria-modal="true"
      >
        <div class="dialog-backdrop absolute inset-0 bg-black/40 md:bg-black/50" @click="onBackdrop" />

        <div
          class="dialog-panel relative flex w-full max-h-[90dvh] flex-col overflow-hidden bg-background shadow-xl rounded-t-2xl md:max-w-md md:max-h-[85vh] md:rounded-2xl"
        >
          <!-- Mobile grab handle -->
          <div class="md:hidden flex justify-center flex-none pt-2 pb-1">
            <div class="h-1 w-9 rounded-full bg-neutral-300" />
          </div>

          <!-- Header -->
          <div
            v-if="title || slots.header"
            class="flex items-center justify-between gap-3 flex-none px-5 pt-3 pb-2 md:pt-4"
          >
            <slot name="header">
              <h2 class="text-size-medium font-semibold text-neutral-900">{{ title }}</h2>
            </slot>
            <button
              type="button"
              class="p-1 -mr-1 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 rounded-md transition-colors flex-none"
              aria-label="Close"
              @click="close"
            >
              <div class="svg-icon w-4 h-4" v-html="closeIcon" />
            </button>
          </div>

          <!-- Body -->
          <div class="flex-1 overflow-y-auto px-5 pt-1 pb-5" :class="{ 'pt-4': !title && !slots.header }">
            <slot />
          </div>

          <!-- Footer (optional, stays pinned) -->
          <div v-if="slots.footer" class="flex-none px-5 py-4 border-t border-neutral-100">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dialog-enter-active .dialog-backdrop,
.dialog-leave-active .dialog-backdrop {
  transition: opacity 0.2s ease;
}

.dialog-enter-active .dialog-panel,
.dialog-leave-active .dialog-panel {
  transition:
    transform 0.28s cubic-bezier(0.32, 0.72, 0, 1),
    opacity 0.2s ease;
}

.dialog-enter-from .dialog-backdrop,
.dialog-leave-to .dialog-backdrop {
  opacity: 0;
}

/* Mobile: slide up from the bottom like a drawer. */
.dialog-enter-from .dialog-panel,
.dialog-leave-to .dialog-panel {
  transform: translateY(100%);
}

/* Desktop: subtle fade + scale for a centered modal. */
@media (min-width: 768px) {
  .dialog-enter-from .dialog-panel,
  .dialog-leave-to .dialog-panel {
    transform: translateY(8px) scale(0.97);
    opacity: 0;
  }
}
</style>
