<script setup lang="ts">
import { twMerge } from "tailwind-merge";
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { Actions } from "#utils/actions.ts";
import { t } from "#utils/lang.ts";
import { lockScroll, unlockScroll } from "#utils/scrollLock.ts";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  parseSidebarWidth,
  SIDEBAR_WIDTH_KEY,
  writeSidebarWidthCookie,
} from "#utils/sidebarState.ts";
import Icon from "./Icon.vue";
import Navigation from "./Navigation.vue";

const props = withDefaults(
  defineProps<{
    defaultWidth?: number;
    minWidth?: number;
    maxWidth?: number;
    initialWidth?: number;
  }>(),
  {
    defaultWidth: DEFAULT_SIDEBAR_WIDTH,
    minWidth: MIN_SIDEBAR_WIDTH,
    maxWidth: MAX_SIDEBAR_WIDTH,
  },
);

const emit = defineEmits<{
  "mobile-open-change": [open: boolean, width: number];
  "mobile-drag-change": [offset: number | null];
}>();

const sidebarRef = ref<HTMLElement | null>(null);
const initialSidebarWidth = parseSidebarWidth(props.initialWidth, props.defaultWidth);
const currentWidth = ref(initialSidebarWidth);
const isResizing = ref(false);
const hasDragged = ref(false);
const displayWidth = ref(initialSidebarWidth);
const isMobileOpen = ref(false);
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartWidth = 0;
const resizeDragThreshold = 4;

let drawerPointerId: number | null = null;
let drawerStartX = 0;
let drawerStartY = 0;
let drawerStartOffset = 0;
const drawerOffset = ref(0);
const drawerWidth = ref(initialSidebarWidth);
const isDrawerDragging = ref(false);
const drawerDragThreshold = 8;
const androidBackGestureInset = 24;

let holdsScrollLock = false;
const setMobileOpen = (open: boolean) => {
  isMobileOpen.value = open;
  if (open && !holdsScrollLock) {
    lockScroll();
    holdsScrollLock = true;
  } else if (!open && holdsScrollLock) {
    unlockScroll();
    holdsScrollLock = false;
  }
  emit("mobile-open-change", open, mobileDrawerWidth());
};

const closeMobile = () => setMobileOpen(false);

function isMobileViewport() {
  return window.matchMedia("(max-width: 767px)").matches;
}

function mobileDrawerWidth() {
  return Math.max(currentWidth.value, props.defaultWidth);
}

function closeMobileDrawerOnDesktop() {
  if (!isMobileViewport() && isMobileOpen.value) setMobileOpen(false);
}

function isAndroidBackGestureAt(clientX: number) {
  return /Android/i.test(navigator.userAgent) && clientX < androidBackGestureInset;
}

function isInsideHorizontallyScrollableContent(targets: readonly EventTarget[]) {
  return targets.some((target) => {
    if (!(target instanceof Element)) return false;
    const { overflowX } = getComputedStyle(target);
    return (
      (overflowX === "auto" || overflowX === "scroll") &&
      target.scrollWidth > target.clientWidth
    );
  });
}

function isDrawerGestureControl(e: TouchEvent) {
  return e
    .composedPath()
    .some(
      (target) =>
        target instanceof Element &&
        target.matches("a-track, input[type='range'], [role='slider']"),
    );
}

function startDrawerDrag(
  pointerId: number,
  clientX: number,
  clientY: number,
  startOffset: number,
) {
  if (!isMobileViewport()) return false;

  drawerPointerId = pointerId;
  drawerStartX = clientX;
  drawerStartY = clientY;
  drawerStartOffset = startOffset;
  drawerOffset.value = startOffset;
  drawerWidth.value = mobileDrawerWidth();
  isDrawerDragging.value = false;
  sidebarRef.value?.style.removeProperty("transform");
  return true;
}

function startDrawerFromScreen(e: TouchEvent) {
  const touch = e.changedTouches[0];
  if (!touch || e.touches.length !== 1) return;
  if (
    isMobileOpen.value ||
    isAndroidBackGestureAt(touch.clientX) ||
    isDrawerGestureControl(e) ||
    isInsideHorizontallyScrollableContent(e.composedPath())
  ) {
    return;
  }
  startDrawerDrag(touch.identifier, touch.clientX, touch.clientY, 0);
}

function startDrawerFromSidebar(e: TouchEvent) {
  if (!isMobileOpen.value) return;
  const touch = e.changedTouches[0];
  if (
    !touch ||
    e.touches.length !== 1 ||
    isDrawerGestureControl(e) ||
    isInsideHorizontallyScrollableContent(e.composedPath())
  ) {
    return;
  }
  startDrawerDrag(touch.identifier, touch.clientX, touch.clientY, mobileDrawerWidth());
}

function startDrawerFromContent(e: TouchEvent) {
  const touch = e.changedTouches[0];
  if (!touch || e.touches.length !== 1) return;
  startDrawerDrag(touch.identifier, touch.clientX, touch.clientY, mobileDrawerWidth());
}

function moveDrawerDrag(pointerId: number, clientX: number, clientY: number) {
  if (pointerId !== drawerPointerId) return false;

  const deltaX = clientX - drawerStartX;
  const deltaY = clientY - drawerStartY;
  if (!isDrawerDragging.value) {
    if (Math.abs(deltaY) > drawerDragThreshold && Math.abs(deltaY) > Math.abs(deltaX)) {
      drawerPointerId = null;
      return false;
    }
    if (Math.abs(deltaX) < drawerDragThreshold) return false;
    const isOpening = drawerStartOffset === 0;
    if ((isOpening && deltaX < 0) || (!isOpening && deltaX > 0)) {
      drawerPointerId = null;
      return false;
    }

    isDrawerDragging.value = true;
  }

  drawerOffset.value = Math.max(
    0,
    Math.min(drawerWidth.value, drawerStartOffset + deltaX),
  );
  sidebarRef.value?.style.setProperty(
    "transform",
    `translateX(${drawerOffset.value - drawerWidth.value}px)`,
  );
  emit("mobile-drag-change", drawerOffset.value);
  return true;
}

function stopDrawerDrag(pointerId: number) {
  if (pointerId !== drawerPointerId) return;
  drawerPointerId = null;

  if (!isDrawerDragging.value) return;

  isDrawerDragging.value = false;
  emit("mobile-drag-change", null);
  setMobileOpen(drawerOffset.value >= drawerWidth.value / 2);
}

function cancelDrawerDrag() {
  drawerPointerId = null;
  if (!isDrawerDragging.value) return;

  isDrawerDragging.value = false;
  emit("mobile-drag-change", null);
  setMobileOpen(isMobileOpen.value);
}

function handleDrawerTouchMove(e: TouchEvent) {
  const touch = changedDrawerTouch(e);
  if (!touch) return;

  const deltaX = touch.clientX - drawerStartX;
  const deltaY = touch.clientY - drawerStartY;
  const isOpening = drawerStartOffset === 0;
  const isDrawerDirection = isOpening ? deltaX > 0 : deltaX < 0;
  if (isDrawerDirection && Math.abs(deltaX) > Math.abs(deltaY)) {
    if (!e.cancelable) {
      cancelDrawerDrag();
      return;
    }
    e.preventDefault();
  }

  moveDrawerDrag(touch.identifier, touch.clientX, touch.clientY);
}

function handleScreenDrawerMove(e: TouchEvent) {
  if (!isMobileOpen.value) handleDrawerTouchMove(e);
}

function stopScreenDrawerDrag(e: TouchEvent) {
  if (isMobileOpen.value) return;
  const touch = changedDrawerTouch(e);
  if (touch) stopDrawerDrag(touch.identifier);
}

function changedDrawerTouch(e: TouchEvent) {
  for (let index = 0; index < e.changedTouches.length; index += 1) {
    const touch = e.changedTouches.item(index);
    if (touch?.identifier === drawerPointerId) return touch;
  }
  return null;
}

function handleOpenDrawerMove(e: TouchEvent) {
  if (isMobileOpen.value) handleDrawerTouchMove(e);
}

function stopOpenDrawerDrag(e: TouchEvent) {
  if (!isMobileOpen.value) return;
  const touch = changedDrawerTouch(e);
  if (touch) stopDrawerDrag(touch.identifier);
}

const handleSidebarClick = (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  if (target.tagName === "A" || target.closest("a")) {
    closeMobile();
  }
};

const toggleCollapse = () => {
  Actions.run("ui:toggle:sidebar");
};

const startResize = (e: MouseEvent) => {
  isResizing.value = true;
  hasDragged.value = false;
  resizeStartX = e.clientX;
  resizeStartY = e.clientY;
  resizeStartWidth = currentWidth.value;
  e.preventDefault();
  e.stopPropagation();

  document.addEventListener("mousemove", handleResize);
  document.addEventListener("mouseup", stopResize);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
};

function dispatchSidebarResize() {
  window.dispatchEvent(
    new CustomEvent("sidebar:resize", { detail: { width: currentWidth.value } }),
  );
}

function persistSidebarWidth(width: number) {
  const parsedWidth = parseSidebarWidth(width, props.defaultWidth);
  localStorage.setItem(SIDEBAR_WIDTH_KEY, parsedWidth.toString());
  writeSidebarWidthCookie(parsedWidth);
}

const handleResize = (e: MouseEvent) => {
  if (!isResizing.value || !sidebarRef.value) return;

  const deltaX = e.clientX - resizeStartX;
  const deltaY = e.clientY - resizeStartY;
  if (!hasDragged.value) {
    const distance = Math.hypot(deltaX, deltaY);
    if (distance < resizeDragThreshold) return;
    hasDragged.value = true;
  }

  let newWidth = resizeStartWidth + deltaX;

  // Snap to default width or min width within 10px threshold
  const snapThreshold = 15;
  if (Math.abs(newWidth - props.defaultWidth) <= snapThreshold) {
    newWidth = props.defaultWidth;
  } else if (Math.abs(newWidth - props.minWidth) <= snapThreshold) {
    newWidth = props.minWidth;
  }

  if (newWidth < props.minWidth) {
    const overshoot = props.minWidth - newWidth;
    displayWidth.value = props.minWidth - overshoot * 0.2;
  } else if (newWidth > props.maxWidth) {
    const overshoot = newWidth - props.maxWidth;
    displayWidth.value = props.maxWidth + overshoot * 0.2;
  } else {
    displayWidth.value = newWidth;
  }

  const clampedWidth = Math.max(
    props.minWidth,
    Math.min(props.maxWidth, displayWidth.value),
  );

  currentWidth.value = clampedWidth;
  dispatchSidebarResize();
};

const stopResize = () => {
  const didDrag = hasDragged.value;
  isResizing.value = false;
  document.removeEventListener("mousemove", handleResize);
  document.removeEventListener("mouseup", stopResize);
  document.body.style.cursor = "";
  document.body.style.userSelect = "";

  if (!didDrag) {
    toggleCollapse();
    return;
  }

  const clampedWidth = Math.max(
    props.minWidth,
    Math.min(props.maxWidth, displayWidth.value),
  );
  currentWidth.value = clampedWidth;
  displayWidth.value = clampedWidth;

  persistSidebarWidth(currentWidth.value);
  dispatchSidebarResize();
};

onMounted(() => {
  window.addEventListener("resize", closeMobileDrawerOnDesktop);
  document.addEventListener("touchstart", startDrawerFromScreen, { capture: true });
  document.addEventListener("touchmove", handleScreenDrawerMove, {
    capture: true,
    passive: false,
  });
  document.addEventListener("touchend", stopScreenDrawerDrag, { capture: true });
  document.addEventListener("touchcancel", stopScreenDrawerDrag, { capture: true });

  Actions.register("ui:toggle:sidebar", {
    title: t("Toggle Sidebar"),
    description: t("Open or close the sidebar menu"),
    group: "navigation",
    run: async () => {
      const targetWidth =
        currentWidth.value === props.minWidth ? props.defaultWidth : props.minWidth;
      currentWidth.value = targetWidth;
      displayWidth.value = targetWidth;
      persistSidebarWidth(targetWidth);
      dispatchSidebarResize();
      nextTick(() => window.dispatchEvent(new Event("resize")));
    },
  });

  Actions.register("sidebar:toggle-mobile", {
    title: t("Toggle Mobile Sidebar"),
    description: t("Open or close the mobile sidebar menu"),
    group: "navigation",
    run: async () => {
      setMobileOpen(!isMobileOpen.value);
    },
  });

  let initialWidth = initialSidebarWidth;
  const savedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (savedWidth) {
    initialWidth = parseSidebarWidth(savedWidth, initialWidth);
  }
  currentWidth.value = initialWidth;
  displayWidth.value = initialWidth;
  persistSidebarWidth(initialWidth);

  // Publish the resolved width so subscribers (page insets, toolbar, docked
  // panels) sync to the actual component state on mount.
  dispatchSidebarResize();
});

onUnmounted(() => {
  window.removeEventListener("resize", closeMobileDrawerOnDesktop);
  document.removeEventListener("touchstart", startDrawerFromScreen, true);
  document.removeEventListener("touchmove", handleScreenDrawerMove, true);
  document.removeEventListener("touchend", stopScreenDrawerDrag, true);
  document.removeEventListener("touchcancel", stopScreenDrawerDrag, true);
  emit("mobile-drag-change", null);
  if (holdsScrollLock) {
    unlockScroll();
    holdsScrollLock = false;
  }
  emit("mobile-open-change", false, mobileDrawerWidth());
  Actions.unregister("ui:toggle:sidebar");
  Actions.unregister("sidebar:toggle-mobile");
});
</script>

<template>
  <div>
    <!-- The open drawer is modal on mobile: drag anywhere in the exposed
         content area to push it back to the left. -->
    <!-- biome-ignore lint/a11y/noStaticElementInteractions: Pointer gestures are the control's only interaction. -->
    <div
      v-show="isMobileOpen"
      class="fixed inset-y-0 right-0 z-40 md:hidden touch-pan-y"
      :style="{ left: `${mobileDrawerWidth()}px` }"
      @touchstart="startDrawerFromContent"
      @touchmove="handleOpenDrawerMove"
      @touchend="stopOpenDrawerDrag"
      @touchcancel="stopOpenDrawerDrag"
    />

    <!-- Sidebar -->
    <!-- biome-ignore lint/a11y/noStaticElementInteractions: The handler forwards pointer events within this Vue component; the element is not a standalone control. -->
    <!-- biome-ignore lint/a11y/useKeyWithClickEvents: This Vue event handler is supplemental to the component's keyboard interaction model. -->
    <div
      ref="sidebarRef"
      :style="{
            '--sidebar-rendered-width': `${displayWidth}px`,
            '--mobile-sidebar-width': `${mobileDrawerWidth()}px`,
            transform: isDrawerDragging
              ? `translateX(${drawerOffset - drawerWidth}px)`
              : undefined,
            transition: isDrawerDragging ? 'none' : undefined,
            '--color-background': 'var(--color-neutral-25)'
        }"
      :class="[
            '@container sidebar p-1.5 flex',
            'fixed top-0 bottom-0 w-(--mobile-sidebar-width) md:w-(--sidebar-rendered-width) transition-transform will-change-transform touch-pan-y',
            'z-40 md:z-10',
            'md:translate-x-0',
            isMobileOpen || isDrawerDragging ? 'translate-x-0' : '-translate-x-full'
        ]"
      @click="handleSidebarClick"
      @touchstart="startDrawerFromSidebar"
      @touchmove="handleOpenDrawerMove"
      @touchend="stopOpenDrawerDrag"
      @touchcancel="stopOpenDrawerDrag"
    >
      <span
        aria-hidden="true"
        class="absolute left-full ml-1 top-1/2 h-12 w-1 -translate-y-1/2 rounded-full bg-neutral-300/70 md:hidden"
      />

      <!-- Toggle Button - Floating on Right Border -->
      <button
        @click.stop="toggleCollapse"
        type="button"
        class="hidden md:block absolute bottom-7 -right-3 z-50 p-2 rounded-full bg-background hover:bg-neutral-100 transition-colors text-neutral-600 hover:text-neutral-900"
        :title="currentWidth === minWidth ? 'Expand sidebar' : 'Collapse sidebar'"
      >
        <Icon
          name="collapse"
          :class="twMerge(
                    'w-4 h-4 transition-transform',
                    currentWidth === minWidth ? 'rotate-180' : ''
                )"
        />
      </button>

      <div
        class="before:backdrop-surface-blur flex flex-col bg-background/90 rounded-lg relative overflow-hidden w-full h-full"
      >
        <Navigation />
      </div>

      <!-- Desktop Resize Handle -->
      <!-- biome-ignore lint/a11y/noStaticElementInteractions: The handler forwards pointer events within this Vue component; the element is not a standalone control. -->
      <div
        :class="[
                'hidden md:block absolute top-2 bottom-2 right-1 w-1 cursor-col-resize hover:bg-primary-200/50 transition-colors group z-20',
                isResizing && 'bg-primary-200/50 active:bg-primary-200' || ''
            ]"
        @mousedown="startResize"
      >
        <div class="absolute inset-y-0 -right-1 w-3"></div>
      </div>
    </div>
  </div>
</template>
