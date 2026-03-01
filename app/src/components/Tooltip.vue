<script setup lang="ts">
import { ref } from "vue";

interface Props {
  text: string;
  position?: "top" | "bottom" | "left" | "right";
  delay?: number;
}

const props = withDefaults(defineProps<Props>(), {
  position: "top",
  delay: 200,
});

const showTooltip = ref(false);
let timeoutId: ReturnType<typeof setTimeout> | null = null;

const handleMouseEnter = () => {
  timeoutId = setTimeout(() => {
    showTooltip.value = true;
  }, props.delay);
};

const handleMouseLeave = () => {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
  showTooltip.value = false;
};

const positionClasses = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
  left: "right-full top-1/2 -translate-y-1/2 mr-2",
  right: "left-full top-1/2 -translate-y-1/2 ml-2",
};

const arrowClasses = {
  top: "top-full left-1/2 -translate-x-1/2 border-l-transparent border-r-transparent border-b-transparent border-t-neutral-900",
  bottom:
    "bottom-full left-1/2 -translate-x-1/2 border-l-transparent border-r-transparent border-t-transparent border-b-neutral-900",
  left: "left-full top-1/2 -translate-y-1/2 border-t-transparent border-b-transparent border-r-transparent border-l-neutral-900",
  right:
    "right-full top-1/2 -translate-y-1/2 border-t-transparent border-b-transparent border-l-transparent border-r-neutral-900",
};
</script>

<template>
  <div class="relative" @mouseenter="handleMouseEnter" @mouseleave="handleMouseLeave">
    <slot />
    <Transition enter-active-class="transition-opacity duration-150" enter-from-class="opacity-0"
      enter-to-class="opacity-100" leave-active-class="transition-opacity duration-150" leave-from-class="opacity-100"
      leave-to-class="opacity-0">
      <div v-if="showTooltip" :class="['absolute z-50 whitespace-nowrap', positionClasses[position]]">
        <div class="relative px-2 py-1 text-xs text-white bg-neutral-300 rounded shadow-lg">
          {{ text }}
          <div :class="['absolute w-0 h-0 border-4', arrowClasses[position]]" />
        </div>
      </div>
    </Transition>
  </div>
</template>
