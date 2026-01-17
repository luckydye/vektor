<script setup lang="ts">
import { ref, onMounted, onUnmounted, watchEffect } from "vue";
import { Actions } from "../utils/actions.ts";
import { Icon } from ".";
import { twMerge } from "tailwind-merge";
import Navigation from "./Navigation.vue";
import UserProfile from "./UserProfile.vue";

const props = withDefaults(
  defineProps<{
    defaultWidth?: number;
    minWidth?: number;
    maxWidth?: number;
  }>(),
  {
    defaultWidth: 288,
    minWidth: 70,
    maxWidth: 500,
  },
);

const sidebarRef = ref<HTMLElement | null>(null);
const currentWidth = ref();
const isResizing = ref(false);
const displayWidth = ref();
const isMobileOpen = ref(false);

const closeMobile = () => {
  isMobileOpen.value = false;
  document.body.style.overflow = "";
};

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
  e.preventDefault();

  document.addEventListener("mousemove", handleResize);
  document.addEventListener("mouseup", stopResize);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
};

const handleResize = (e: MouseEvent) => {
  if (!isResizing.value || !sidebarRef.value) return;

  const rect = sidebarRef.value.getBoundingClientRect();
  let newWidth = e.clientX - rect.left;

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
};

const stopResize = () => {
  isResizing.value = false;
  document.removeEventListener("mousemove", handleResize);
  document.removeEventListener("mouseup", stopResize);
  document.body.style.cursor = "";
  document.body.style.userSelect = "";

  const clampedWidth = Math.max(
    props.minWidth,
    Math.min(props.maxWidth, displayWidth.value),
  );
  currentWidth.value = clampedWidth;
  displayWidth.value = clampedWidth;

  localStorage.setItem("sidebar-width", currentWidth.value.toString());
};

onMounted(() => {
  Actions.register("ui:toggle:sidebar", {
    title: "Toggle Sidebar",
    description: "Open or close the sidebar menu",
    group: "navigation",
    run: async () => {
      const targetWidth = currentWidth.value === props.minWidth ? props.defaultWidth : props.minWidth;
      currentWidth.value = targetWidth;
      displayWidth.value = targetWidth;
      localStorage.setItem("sidebar-width", targetWidth.toString());
    },
  });

  Actions.register("sidebar:toggle", {
    title: "Toggle Sidebar",
    description: "Open or close the sidebar menu",
    group: "navigation",
    run: async () => {
      isMobileOpen.value = !isMobileOpen.value;

      if (isMobileOpen.value) {
        document.body.style.overflow = "hidden";
      } else {
        document.body.style.overflow = "";
      }
    },
  });

  const savedWidth = localStorage.getItem("sidebar-width");
  if (savedWidth) {
    const width = parseInt(savedWidth, 10);
    if (width >= props.minWidth && width <= props.maxWidth) {
      currentWidth.value = width;
      displayWidth.value = width;
      return;
    }
  }

  const initialWidth = props.defaultWidth || props.minWidth;
  currentWidth.value = initialWidth;
  displayWidth.value = initialWidth;
});

watchEffect(() => {
  if (typeof window !== "undefined") {
    document.body.style.setProperty("--sidebar-width", `${currentWidth.value}px`);
  }
});

onUnmounted(() => {
  document.body.style.overflow = "";
  Actions.unregister("sidebar:toggle");
});
</script>

<template>
  <div>
    <!-- Backdrop Overlay for Mobile -->
    <div
      v-if="isMobileOpen"
      @click="closeMobile"
      class="fixed inset-0 bg-black/50 z-30 lg:hidden transition-opacity"
    ></div>

    <!-- Sidebar -->
    <div
      ref="sidebarRef"
      :style="{
        width: `${displayWidth}px`,
        '--color-background': 'var(--color-neutral-50)'
      }"
      :class="[
        'sidebar',
        'flex flex-col bg-background fixed top-0 bottom-0 w-(--sidebar-width) transition-transform',
        'z-40 lg:z-10',
        'lg:translate-x-0',
        isMobileOpen ? 'translate-x-0' : '-translate-x-full'
      ]"
      @click="handleSidebarClick"
    >
      <!-- Toggle Button - Floating on Right Border -->
      <button
        @click.stop="toggleCollapse"
        type="button"
        class="hidden lg:block absolute bottom-6 -right-3 z-50 p-2 rounded-full bg-background hover:bg-neutral-100 transition-colors text-neutral-600 hover:text-neutral-900"
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

      <!-- Navigation -->
      <wiki-scroll name="navigation" class="flex-1 overflow-y-auto overflow-x-hidden min-w-[70px]">
        <Navigation />
      </wiki-scroll>

      <!-- Bottom Actions -->
      <div
        class="px-1 py-3 bg-background relative"
      >
        <!-- User Profile -->
        <div class="flex">
          <UserProfile />
        </div>
      </div>

      <!-- Desktop Resize Handle -->
      <div
        :class="[
          'hidden lg:block absolute top-0 bottom-0 right-0 w-px cursor-col-resize hover:bg-blue-500 transition-colors group z-20',
          isResizing && 'bg-blue-500' || 'bg-neutral-100'
        ]"
        @mousedown="startResize"
      >
        <div class="absolute inset-y-0 -right-1 w-3"></div>
      </div>
    </div>
  </div>
</template>
