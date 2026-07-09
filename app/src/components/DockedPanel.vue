<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  type DockedWindowState,
  useDockedWindows,
} from "#composeables/useDockedWindows.ts";
import { useIsDesktop } from "#composeables/useIsDesktop.ts";
import { getInsets, type Insets, onInsets } from "#utils/insets.ts";
import {
  closeXIcon,
  dragDotsIcon,
  panelRightIcon,
  resizeHandleIcon,
  windowRestoreIcon,
} from "~/src/assets/icons.ts";
import Dialog from "./Dialog.vue";

const props = defineProps<{
  id: string;
  title: string;
  defaultSide?: "left" | "right";
  defaultWidth?: number;
  defaultMode?: "docked" | "floating";
}>();

const DOCK_THRESHOLD = 100;
const DOCK_MARGIN = 6;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 200;

const {
  register,
  deregister,
  close,
  dock,
  undock,
  setWidth,
  setPosition,
  windows,
  leftWindows,
  rightWindows,
} = useDockedWindows();

// Reactive window state derived from composable
const state = computed<DockedWindowState | undefined>(() => windows.value.get(props.id));
const isOpen = computed(() => state.value?.open ?? false);
const mode = computed(() => state.value?.mode ?? "docked");
const side = computed(() => state.value?.side ?? props.defaultSide ?? "right");
const width = computed(() => state.value?.width ?? props.defaultWidth ?? 380);

// Floating position refs (used during drag/resize, synced to composable on end)
const floatX = ref(100);
const floatY = ref(100);
const floatW = ref(props.defaultWidth ?? 380);
const floatH = ref(600);

// Layout insets (sidebar + docked panels), kept in sync via the inset subscriber.
const insets = ref<Insets>(getInsets());
let stopInsets: (() => void) | null = null;

// Track the md breakpoint reactively so docked positioning recomputes when the
// sidebar collapses to an overlay below it, and so the panel becomes a bottom
// drawer on mobile.
const isDesktop = useIsDesktop();

function sidebarOffset(): number {
  return isDesktop.value ? insets.value.sidebar : 0;
}

// Sum of same-side docked panel widths stacked before this one.
function precedingWidth(): number {
  const list = side.value === "left" ? leftWindows.value : rightWindows.value;
  const idx = list.findIndex((w) => w.id === props.id);
  return list.slice(0, Math.max(0, idx)).reduce((sum, w) => sum + w.width, 0);
}

// Left edge (viewport px) of this panel when docked.
function dockedLeft(): number {
  if (side.value === "left") return sidebarOffset() + precedingWidth();
  return window.innerWidth - precedingWidth() - width.value;
}

// Computed style for the fixed overlay. Docked panels derive their position
// from the inset system rather than a measured placeholder, anchoring to the
// relevant edge so no viewport math is needed: left panels sit past the sidebar
// (and any panels stacked before them), right panels stack in from the right.
const overlayStyle = computed(() => {
  if (mode.value === "docked") {
    const base = {
      top: `${DOCK_MARGIN}px`,
      width: `${width.value}px`,
      height: `calc(100vh - ${DOCK_MARGIN * 2}px)`,
    };
    return side.value === "left"
      ? { ...base, left: `${sidebarOffset() + precedingWidth()}px` }
      : { ...base, right: `${precedingWidth()}px` };
  }
  return {
    left: `${floatX.value}px`,
    top: `${floatY.value}px`,
    width: `${floatW.value}px`,
    height: `${floatH.value}px`,
  };
});

// Sync floating refs from composable state
watch(
  state,
  (s) => {
    if (!s) return;
    if (s.mode === "floating") {
      if (s.x != null) floatX.value = s.x;
      if (s.y != null) floatY.value = s.y;
      if (s.height != null) floatH.value = s.height;
      floatW.value = s.width;
    }
  },
  { immediate: true },
);

// ── Drag ──────────────────────────────────────────────────────────────────────

let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
let windowStartX = 0;
let windowStartY = 0;

function onDragStart(e: MouseEvent) {
  if ((e.target as HTMLElement).closest(".panel-close")) return;
  dragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;

  if (mode.value === "docked") {
    // Start from docked position so the panel tracks the cursor
    windowStartX = dockedLeft();
    windowStartY = DOCK_MARGIN;
    floatX.value = windowStartX;
    floatY.value = windowStartY;
    floatW.value = width.value;
    floatH.value = window.innerHeight - DOCK_MARGIN * 2;
  } else {
    windowStartX = floatX.value;
    windowStartY = floatY.value;
  }
  e.preventDefault();
}

// ── Resize ────────────────────────────────────────────────────────────────────

let resizing = false;
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartW = 0;
let resizeStartH = 0;
let resizeEdge: "inner" | "corner" = "corner";

function onResizeEdgeStart(e: MouseEvent) {
  resizing = true;
  resizeEdge = "inner";
  resizeStartX = e.clientX;
  resizeStartY = e.clientY;
  resizeStartW = width.value;
  resizeStartH = floatH.value;
  e.preventDefault();
  e.stopPropagation();
}

function onResizeCornerStart(e: MouseEvent) {
  resizing = true;
  resizeEdge = "corner";
  resizeStartX = e.clientX;
  resizeStartY = e.clientY;
  resizeStartW = mode.value === "floating" ? floatW.value : width.value;
  resizeStartH = floatH.value;
  e.preventDefault();
  e.stopPropagation();
}

// ── Mouse event handlers (global) ─────────────────────────────────────────────

function onMouseMove(e: MouseEvent) {
  if (dragging) {
    const newX = Math.max(0, windowStartX + (e.clientX - dragStartX));
    const newY = Math.max(0, windowStartY + (e.clientY - dragStartY));

    // If docked and dragged far enough, undock
    if (mode.value === "docked") {
      const threshold =
        side.value === "left"
          ? sidebarOffset() + precedingWidth() + DOCK_THRESHOLD
          : window.innerWidth - width.value - DOCK_THRESHOLD;
      const movedAway = side.value === "left" ? newX > threshold : newX < threshold;

      if (movedAway) {
        undock(props.id);
        floatX.value = newX;
        floatY.value = newY;
      }
    } else {
      floatX.value = newX;
      floatY.value = newY;
    }
  } else if (resizing) {
    if (mode.value === "docked") {
      // Width-only resize for docked panels — the overlay repositions reactively
      // through the inset system as the width changes.
      const dx = e.clientX - resizeStartX;
      const dir = side.value === "right" ? -1 : 1;
      const newW = Math.max(MIN_WIDTH, resizeStartW + dx * dir);
      setWidth(props.id, newW);
    } else {
      // Free resize for floating
      floatW.value = Math.max(MIN_WIDTH, resizeStartW + (e.clientX - resizeStartX));
      if (resizeEdge === "corner") {
        floatH.value = Math.max(MIN_HEIGHT, resizeStartH + (e.clientY - resizeStartY));
      }
    }
  }
}

function onMouseUp() {
  if (dragging) {
    // Snap-to-dock if near edges
    if (mode.value === "floating") {
      const sidebar = sidebarOffset();
      const nearLeft = floatX.value < sidebar + DOCK_THRESHOLD;
      const nearRight = floatX.value + floatW.value > window.innerWidth - DOCK_THRESHOLD;

      if (nearLeft) {
        dock(props.id, "left");
      } else if (nearRight) {
        dock(props.id, "right");
      } else {
        setPosition(props.id, floatX.value, floatY.value, floatW.value, floatH.value);
      }
    }
    dragging = false;
  } else if (resizing) {
    if (mode.value === "floating") {
      setPosition(props.id, floatX.value, floatY.value, floatW.value, floatH.value);
    }
    resizing = false;
  }
}

function onWindowResize() {
  if (mode.value === "floating") {
    // Clamp floating position
    const maxX = window.innerWidth - floatW.value - DOCK_MARGIN;
    if (floatX.value > maxX) floatX.value = Math.max(0, maxX);
    const maxY = window.innerHeight - floatH.value - DOCK_MARGIN;
    if (floatY.value > maxY) floatY.value = Math.max(0, maxY);
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

function onClose() {
  close(props.id);
}

function onDock() {
  dock(props.id, side.value);
}

function onUndock() {
  // Position floating window roughly where the docked one was
  floatX.value = dockedLeft() + 20;
  floatY.value = 40;
  floatW.value = width.value;
  floatH.value = window.innerHeight - 80;
  undock(props.id);
  setPosition(props.id, floatX.value, floatY.value, floatW.value, floatH.value);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(() => {
  register(props.id, {
    mode: props.defaultMode ?? "docked",
    side: props.defaultSide ?? "right",
    width: props.defaultWidth ?? 380,
  });

  stopInsets = onInsets((s) => {
    insets.value = s;
  });

  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("resize", onWindowResize);
});

onUnmounted(() => {
  deregister(props.id);
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mouseup", onMouseUp);
  window.removeEventListener("resize", onWindowResize);
  stopInsets?.();
});
</script>

<template>
  <!-- Mobile: render as a bottom-drawer dialog instead of a docked/floating panel. -->
  <Dialog
    v-if="!isDesktop"
    :show="isOpen"
    :title="title"
    expand
    body-class="p-0 flex flex-col min-h-0 overflow-hidden"
    @update:show="(v) => { if (!v) onClose(); }"
  >
    <slot />
  </Dialog>

  <!-- Desktop: docked / floating overlay. -->
  <div
    v-else-if="isOpen"
    class="fixed z-50 flex flex-col bg-neutral-10 border border-neutral-100 rounded-md overflow-hidden shadow-xl"
    :style="overlayStyle"
  >
    <!-- Header / drag handle -->
    <!-- biome-ignore lint/a11y/noStaticElementInteractions: The handler forwards pointer events within this Vue component; the element is not a standalone control. -->
    <div
      class="flex items-center gap-2 px-3 py-2.5 bg-neutral-10 border-b border-neutral-100 cursor-move select-none shrink-0"
      @mousedown="onDragStart"
    >
      <!-- Drag dots -->
      <div class="svg-icon w-3.5 h-3.5 text-neutral-400 shrink-0" v-html="dragDotsIcon" />
      <span class="text-size-medium text-neutral-800 font-semibold flex-1">{{ title }}</span>
      <!-- Right controls -->
      <div class="panel-close flex items-center gap-0.5">
        <!-- Dock/undock toggle -->
        <button type="button"
          v-if="mode === 'floating'"
          class="p-1 text-neutral-500 hover:text-neutral-800 rounded-sm transition-colors"
          title="Dock panel"
          @click="onDock"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="panelRightIcon" />
        </button>
        <button type="button"
          v-else
          class="p-1 text-neutral-500 hover:text-neutral-800 rounded-sm transition-colors"
          title="Undock panel"
          @click="onUndock"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="windowRestoreIcon" />
        </button>
        <!-- Close -->
        <button type="button"
          class="p-1 text-neutral-500 hover:text-neutral-800 rounded-sm transition-colors"
          @click="onClose"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="closeXIcon" />
        </button>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 min-h-0 overflow-hidden">
      <slot />
    </div>

    <!-- Resize handle: inner edge for docked, corner for floating -->
    <!-- biome-ignore lint/a11y/noStaticElementInteractions: The handler forwards pointer events within this Vue component; the element is not a standalone control. -->
    <div
      v-if="mode === 'docked'"
      class="absolute top-0 h-full w-1.5 cursor-ew-resize hover:bg-primary-200/30 transition-colors"
      :class="side === 'right' ? 'left-0' : 'right-0'"
      @mousedown="onResizeEdgeStart"
    />
    <!-- biome-ignore lint/a11y/noStaticElementInteractions: The handler forwards pointer events within this Vue component; the element is not a standalone control. -->
    <div
      v-else
      class="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
      @mousedown="onResizeCornerStart"
    >
      <div class="svg-icon w-4 h-4 text-neutral-400" v-html="resizeHandleIcon" />
    </div>
  </div>
</template>
