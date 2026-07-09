<script setup lang="ts">
import { onBeforeUnmount, useSlots, watch } from "vue";
import { lockScroll, unlockScroll } from "#utils/scrollLock.ts";
import { closeIcon } from "~/src/assets/icons.ts";
import "@atrium-ui/elements/blur";

const props = withDefaults(
  defineProps<{
    show?: boolean;
    title?: string;
    /** Allow dismissing via backdrop click or Escape. */
    closeOnBackdrop?: boolean;
    /** Desktop max-width utility class (mobile is always full-width). */
    maxWidth?: string;
    /** Override body classes (padding + overflow). Pass e.g. "p-0" for
     * full-bleed content, or your own overflow for self-scrolling content. */
    bodyClass?: string;
    /** Fill to a fixed tall height instead of fitting content. Needed for
     * content that manages its own internal scroll (e.g. docked panels): a
     * definite height lets a child's `h-full`/`flex-1` scroll region resolve. */
    expand?: boolean;
  }>(),
  {
    show: false,
    title: "",
    closeOnBackdrop: true,
    maxWidth: "md:max-w-md",
    bodyClass: "px-5 pt-1 pb-5 overflow-y-auto",
    expand: false,
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

// Backdrop click and <a-blur>'s exit event (Escape / focus-out) are the
// dismissal paths; both respect closeOnBackdrop. The header ✕ always closes.
function onDismiss() {
  if (props.closeOnBackdrop) close();
}

// Ref-counted body scroll lock so a closing dialog can't unlock the page while
// another overlay (e.g. the mobile sidebar) is still open.
let holdsLock = false;
function applyScrollLock(shouldLock: boolean) {
  if (shouldLock && !holdsLock) {
    lockScroll();
    holdsLock = true;
  } else if (!shouldLock && holdsLock) {
    unlockScroll();
    holdsLock = false;
  }
}

watch(
  () => props.show,
  (show) => applyScrollLock(show),
  { immediate: true },
);

onBeforeUnmount(() => applyScrollLock(false));
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <!-- biome-ignore lint/a11y/noStaticElementInteractions: a-blur emits dismissal events for this modal container. -->
      <a-blur
        v-if="show"
        enabled
        class="dialog-root fixed inset-0 z-100 flex items-end justify-center md:items-center"
        @click="onDismiss"
        @exit="onDismiss"
      >
        <div class="dialog-backdrop absolute inset-0 bg-black/40 md:bg-black/50" />

        <!-- biome-ignore lint/a11y/noStaticElementInteractions: The handler forwards pointer events within this Vue component; the element is not a standalone control. -->
        <!-- biome-ignore lint/a11y/useKeyWithClickEvents: This Vue event handler is supplemental to the component's keyboard interaction model. -->
        <div
          role="dialog"
          aria-modal="true"
          class="dialog-panel relative flex w-full flex-col overflow-hidden bg-background shadow-xl rounded-t-2xl md:rounded-2xl"
          :class="[maxWidth, expand ? 'h-[90dvh] md:h-[85vh]' : 'max-h-[90dvh] md:max-h-[85vh]']"
          @click.stop
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
          <div class="flex-1 min-h-0" :class="bodyClass">
            <slot />
          </div>

          <!-- Footer (optional, stays pinned) -->
          <div v-if="slots.footer" class="flex-none px-5 py-4 border-t border-neutral-100">
            <slot name="footer" />
          </div>
        </div>
      </a-blur>
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
