<script setup lang="ts">
import { computed } from "vue";
import { useContributors } from "../composeables/useContributors.ts";
import Avatar from "./Avatar.vue";
import Tooltip from "./Tooltip.vue";

interface Props {
  documentId?: string;
  max?: number;
}

const props = withDefaults(defineProps<Props>(), {
  max: 5,
});

const { contributors, isLoading, error } = useContributors(props.documentId);

const displayContributors = computed(() => {
  return contributors.value.slice(0, props.max);
});

const remainingCount = computed(() => {
  return Math.max(0, contributors.value.length - props.max);
});
</script>

<template>
  <Tooltip v-if="!isLoading && !error && contributors.length > 0" text="Authors" position="top">
    <div class="flex items-center gap-2">
      <div class="flex items-center">
        <div v-for="(contributor, index) in displayContributors" :key="contributor.id" class="relative" :style="{
          marginLeft: index > 0 ? `-18px` : '0',
          zIndex: displayContributors.length - index
        }" :title="contributor.name">
          <Avatar size="small" :user="contributor" />
        </div>
        <div v-if="remainingCount > 0"
          class="relative flex items-center justify-center rounded-full bg-primary-100 text-label text-primary-400 font-medium border-2 border-background"
          :style="{
            width: `32px`,
            height: `32px`,
            marginLeft: `-18px`,
            zIndex: 0
          }">
          +{{ remainingCount }}
        </div>
      </div>
    </div>
  </Tooltip>
</template>

<style scoped>
[title] {
  cursor: help;
}
</style>
