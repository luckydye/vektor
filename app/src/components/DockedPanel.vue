<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import {
  useDockedWindows,
  type DockedWindowState,
} from "../composeables/useDockedWindows.ts";

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
  getWindow,
  windows,
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

// Docked position (read from placeholder via ResizeObserver)
const dockedRect = ref<DOMRect | null>(null);
const placeholderEl = ref<HTMLElement | null>(null);
let resizeObserver: ResizeObserver | null = null;

// Computed style for the fixed overlay
const overlayStyle = computed(() => {
  if (mode.value === "docked" && dockedRect.value) {
    return {
      left: dockedRect.value.left + "px",
      top: DOCK_MARGIN + "px",
      width: dockedRect.value.width + "px",
      height: `calc(100vh - ${DOCK_MARGIN * 2}px)`,
    };
  }
  return {
    left: floatX.value + "px",
    top: floatY.value + "px",
    width: floatW.value + "px",
    height: floatH.value + "px",
  };
});

function getSidebarWidth(): number {
  if (window.innerWidth < 1024) return 0;
  const w = getComputedStyle(document.body).getPropertyValue("--sidebar-width");
  return parseInt(w, 10) || 250;
}

// ── Placeholder tracking ──────────────────────────────────────────────────────

function findPlaceholder(): HTMLElement | null {
  return document.querySelector(`[data-docked-id="${props.id}"]`);
}

function updateDockedRect() {
  const el = findPlaceholder();
  if (el) {
    placeholderEl.value = el;
    dockedRect.value = el.getBoundingClientRect();
  }
}

function startObservingPlaceholder() {
  stopObservingPlaceholder();
  const el = findPlaceholder();
  if (!el) return;
  placeholderEl.value = el;
  dockedRect.value = el.getBoundingClientRect();
  resizeObserver = new ResizeObserver(() => {
    dockedRect.value = el.getBoundingClientRect();
  });
  resizeObserver.observe(el);
}

function stopObservingPlaceholder() {
  resizeObserver?.disconnect();
  resizeObserver = null;
  placeholderEl.value = null;
}

// Re-observe when mode/side changes to docked
watch(
  () => [mode.value, side.value, isOpen.value],
  () => {
    if (mode.value === "docked" && isOpen.value) {
      // Placeholder may not exist yet in next tick
      requestAnimationFrame(() => startObservingPlaceholder());
    } else {
      stopObservingPlaceholder();
    }
  },
);

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

  if (mode.value === "docked" && dockedRect.value) {
    // Start from docked position so the panel tracks the cursor
    windowStartX = dockedRect.value.left;
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
      const sidebarW = getSidebarWidth();
      const threshold =
        side.value === "left"
          ? sidebarW + DOCK_THRESHOLD
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
      // Width-only resize for docked panels
      const dx = e.clientX - resizeStartX;
      const dir = side.value === "right" ? -1 : 1;
      const newW = Math.max(MIN_WIDTH, resizeStartW + dx * dir);
      setWidth(props.id, newW);
      requestAnimationFrame(() => updateDockedRect());
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
      const sidebarW = getSidebarWidth();
      const nearLeft = floatX.value < sidebarW + DOCK_THRESHOLD;
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
  if (mode.value === "docked") {
    updateDockedRect();
  } else {
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
  if (dockedRect.value) {
    floatX.value = dockedRect.value.left + 20;
    floatY.value = 40;
    floatW.value = width.value;
    floatH.value = window.innerHeight - 80;
  }
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

  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("resize", onWindowResize);
  window.addEventListener("sidebar:resize", updateDockedRect);

  requestAnimationFrame(() => {
    if (mode.value === "docked") {
      startObservingPlaceholder();
    }
  });
});

onUnmounted(() => {
  deregister(props.id);
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mouseup", onMouseUp);
  window.removeEventListener("resize", onWindowResize);
  window.removeEventListener("sidebar:resize", updateDockedRect);
  stopObservingPlaceholder();
});
</script>

<template>
  <div
    v-if="isOpen"
    class="fixed z-50 flex flex-col bg-neutral-10 border border-neutral-100 rounded-md overflow-hidden shadow-xl"
    :style="overlayStyle"
  >
    <!-- Header / drag handle -->
    <div
      class="flex items-center gap-2 px-3 py-2.5 bg-neutral-10 border-b border-neutral-100 cursor-move select-none shrink-0"
      @mousedown="onDragStart"
    >
      <!-- Drag dots -->
      <svg class="w-3.5 h-3.5 text-neutral-400 shrink-0" viewBox="0 0 10 16" fill="currentColor">
        <circle cx="2" cy="3" r="1.3" /><circle cx="2" cy="8" r="1.3" /><circle cx="2" cy="13" r="1.3" />
        <circle cx="8" cy="3" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="8" cy="13" r="1.3" />
      </svg>
      <span class="text-sm text-neutral-800 font-semibold flex-1">{{ title }}</span>
      <!-- Right controls -->
      <div class="panel-close flex items-center gap-0.5">
        <!-- Dock/undock toggle -->
        <button
          v-if="mode === 'floating'"
          class="p-1 text-neutral-500 hover:text-neutral-800 rounded transition-colors"
          title="Dock panel"
          @click="onDock"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
        </button>
        <button
          v-else
          class="p-1 text-neutral-500 hover:text-neutral-800 rounded transition-colors"
          title="Undock panel"
          @click="onUndock"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="5" y="5" width="14" height="14" rx="2" />
            <path d="M3 10V4a1 1 0 011-1h6" />
          </svg>
        </button>
        <!-- Close -->
        <button
          class="p-1 text-neutral-500 hover:text-neutral-800 rounded transition-colors"
          @click="onClose"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 min-h-0 overflow-hidden">
      <slot />
    </div>

    <!-- Resize handle: inner edge for docked, corner for floating -->
    <div
      v-if="mode === 'docked'"
      class="absolute top-0 h-full w-1.5 cursor-ew-resize hover:bg-primary-200/30 transition-colors"
      :class="side === 'right' ? 'left-0' : 'right-0'"
      @mousedown="onResizeEdgeStart"
    />
    <div
      v-else
      class="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
      @mousedown="onResizeCornerStart"
    >
      <svg class="w-4 h-4 text-neutral-400" viewBox="0 0 16 16" fill="currentColor">
        <circle cx="12" cy="12" r="1.2" />
        <circle cx="8" cy="12" r="1.2" />
        <circle cx="12" cy="8" r="1.2" />
      </svg>
    </div>
  </div>
</template>
