<script setup lang="ts">
import { computed } from "vue";
import ActivityTimelineConnector from "../assets/icons/activity-timeline-connector.svg?raw";
import ActivityTimelineConnectorNoAction from "../assets/icons/activity-timeline-connector-no-action.svg?raw";
import MoreIcon from "../assets/icons/more.svg?raw";

interface Props {
  variant?: "default" | "no-action";
  date?: string;
  description?: string;
}

const props = withDefaults(defineProps<Props>(), {
  variant: "default",
  date: "December 2025",
  description: "<Name> Created new revision",
});

const timelineIcon = computed(() =>
  props.variant === "default"
    ? ActivityTimelineConnector
    : ActivityTimelineConnectorNoAction,
);
</script>

<template>
  <div class="flex flex-row gap-2xs">
    <!-- Timeline connector -->
    <div v-html="timelineIcon" class="w-[11px] h-[75px] shrink-0 translate-y-[3px]" />

    <!-- Content -->
    <div class="flex flex-col gap-4xs flex-1">
      <div class="flex items-center gap-2">
        <slot name="icon"></slot>
        <div class="text-label text-neutral-700">
          {{ date }}
        </div>
        <slot name="badge"></slot>
      </div>
      <div class="text-sm text-neutral-800">
        {{ description }}
      </div>
    </div>

    <!-- Action button (only for default variant) -->
    <div v-if="variant === 'default'" class="flex flex-col gap-4xs">
      <slot name="action">
        <button
          class="inline-flex items-center justify-center gap-5xs px-3xs h-[36px] border border-primary-100 rounded-sm hover:bg-primary-10 active:bg-primary-50 transition-colors">
          <div v-html="MoreIcon" class="w-[12px] h-[18px] text-primary-600" />
        </button>
      </slot>
    </div>
  </div>
</template>

<style scoped>
:deep(svg) {
  display: block;
}

:deep(circle) {
  fill: var(--color-neutral-200);
}

:deep(line) {
  stroke: var(--color-neutral-200);
}
</style>
