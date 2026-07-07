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
import { Icon } from "./index.ts";
import Navigation from "./Navigation.vue";
import UserProfile from "./UserProfile.vue";

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
  "mobile-open-change": [open: boolean];
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
  emit("mobile-open-change", open);
};

const closeMobile = () => setMobileOpen(false);

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
  if (holdsScrollLock) {
    unlockScroll();
    holdsScrollLock = false;
  }
  emit("mobile-open-change", false);
  Actions.unregister("ui:toggle:sidebar");
  Actions.unregister("sidebar:toggle-mobile");
});
</script>

<template>
    <div>
        <!-- Sidebar -->
        <div ref="sidebarRef" :style="{
            width: `${displayWidth}px`,
            '--color-background': 'var(--color-neutral-10)'
        }" :class="[
            '@container sidebar p-1.5 flex',
            'fixed top-0 bottom-0 w-(--sidebar-width) transition-transform',
            'z-40 md:z-10',
            'md:translate-x-0',
            isMobileOpen ? 'translate-x-0' : '-translate-x-full'
        ]" @click="handleSidebarClick">
            <!-- Toggle Button - Floating on Right Border -->
            <button @click.stop="toggleCollapse" type="button"
                class="hidden md:block absolute bottom-7.5 -right-3 z-50 p-2 rounded-full bg-background hover:bg-neutral-100 transition-colors text-neutral-600 hover:text-neutral-900"
                :title="currentWidth === minWidth ? 'Expand sidebar' : 'Collapse sidebar'">
                <Icon name="collapse" :class="twMerge(
                    'w-4 h-4 transition-transform',
                    currentWidth === minWidth ? 'rotate-180' : ''
                )" />
            </button>
            
            <div class="before:backdrop-surface-blur flex flex-col bg-background/90 rounded-lg relative overflow-hidden border border-neutral-200 w-full h-full">
                <!-- Navigation -->
                <wiki-scroll name="navigation" class="z-1 flex-1 overflow-y-auto overflow-x-hidden min-w-[60px]">
                    <Navigation />
                </wiki-scroll>

                <!-- Bottom Actions -->
                <div class="px-1 py-3 relative flex items-center">
                    <!-- User Profile -->
                    <UserProfile />
                </div>
            </div>
            
            <!-- Desktop Resize Handle -->
            <div :class="[
                'hidden md:block absolute top-2 bottom-2 right-1 w-1 cursor-col-resize hover:bg-primary-200/50 transition-colors group z-20',
                isResizing && 'bg-primary-200/50 active:bg-primary-200' || ''
            ]" @mousedown="startResize">
                <div class="absolute inset-y-0 -right-1 w-3"></div>
            </div>
        </div>
    </div>
</template>
