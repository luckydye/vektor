<script setup lang="ts">
import { onBeforeUnmount, useSlots, watch } from "vue";
import { t } from "#utils/lang.ts";
import { lockScroll, unlockScroll } from "#utils/scrollLock.ts";
import { cancelIcon } from "~/src/assets/icons.ts";
import ClientOnly from "./ClientOnly.vue";
import "@atrium-ui/elements/blur";

const props = withDefaults(
  defineProps<{
    show?: boolean;
    title?: string;
    /** Allow dismissing via backdrop click or Escape. */
    closeOnBackdrop?: boolean;
    /** Desktop max-width utility class (mobile is always full-width). */
    maxWidth?: string;
    /** Optional fixed panel height. Content still scrolls within the body. */
    panelHeight?: string;
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
    panelHeight: "",
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
  <ClientOnly>
    <Teleport to="body">
      <Transition
        enter-active-class="[&_.dialog-backdrop]:transition-opacity [&_.dialog-backdrop]:duration-200 [&_.dialog-backdrop]:ease-[ease] [&_.dialog-panel]:[transition:transform_0.28s_cubic-bezier(0.32,0.72,0,1),opacity_0.2s_ease]"
        enter-from-class="[&_.dialog-backdrop]:opacity-0 [&_.dialog-panel]:translate-y-full md:[&_.dialog-panel]:translate-y-2 md:[&_.dialog-panel]:scale-[0.97] md:[&_.dialog-panel]:opacity-0"
        leave-active-class="[&_.dialog-backdrop]:transition-opacity [&_.dialog-backdrop]:duration-200 [&_.dialog-backdrop]:ease-[ease] [&_.dialog-panel]:[transition:transform_0.28s_cubic-bezier(0.32,0.72,0,1),opacity_0.2s_ease]"
        leave-to-class="[&_.dialog-backdrop]:opacity-0 [&_.dialog-panel]:translate-y-full md:[&_.dialog-panel]:translate-y-2 md:[&_.dialog-panel]:scale-[0.97] md:[&_.dialog-panel]:opacity-0"
      >
        <!-- biome-ignore lint/a11y/noStaticElementInteractions: a-blur emits dismissal events for this modal container. -->
        <a-blur
          v-if="show"
          enabled
          class="fixed inset-0 z-100 flex items-end justify-center md:items-center"
          @exit="onDismiss"
        >
          <button
            type="button"
            class="dialog-backdrop absolute inset-0 border-0 bg-black/40 md:bg-black/50"
            :aria-label="t('Close dialog')"
            @click="onDismiss"
          />

          <!-- biome-ignore lint/a11y/noStaticElementInteractions: The handler forwards pointer events within this Vue component; the element is not a standalone control. -->
          <!-- biome-ignore lint/a11y/useKeyWithClickEvents: This Vue event handler is supplemental to the component's keyboard interaction model. -->
          <div
            role="dialog"
            aria-modal="true"
            class="dialog-panel relative flex w-full flex-col overflow-hidden bg-background shadow-xl rounded-t-2xl md:rounded-2xl"
            :class="[
              maxWidth,
              panelHeight,
              expand ? 'h-[90dvh] md:h-[85vh]' : 'max-h-[90dvh] md:max-h-[85vh]',
            ]"
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
                <h2 class="text-size-medium font-semibold text-neutral-900">
                  {{ title }}
                </h2>
              </slot>
              <button
                type="button"
                class="p-1 -mr-1 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 rounded-md transition-colors flex-none"
                :aria-label="t('Close')"
                @click="close"
              >
                <div class="svg-icon w-4 h-4" v-html="cancelIcon" />
              </button>
            </div>

            <!-- Body -->
            <div class="flex-1 min-h-0" :class="bodyClass">
              <slot />
            </div>

            <!-- Footer (optional, stays pinned) -->
            <div
              v-if="slots.footer"
              class="flex-none px-5 py-4 border-t border-neutral-100"
            >
              <slot name="footer" />
            </div>
          </div>
        </a-blur>
      </Transition>
    </Teleport>
  </ClientOnly>
</template>
