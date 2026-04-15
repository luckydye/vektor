<script setup lang="ts">
import "@sv/elements/popover";
import { ref, watch, computed } from "vue";
import homeIcon from "../assets/icons/home.svg?raw";
import settingsIcon from "../assets/icons/settings.svg?raw";
import ButtonSecondary from "./ButtonSecondary.vue";
import Icon from "./Icon.vue";
import ButtonPrimary from "./ButtonPrimary.vue";

// UI-specific Space interface for the selector
interface Space {
  id: string;
  name: string;
  members?: number;
  color?: string;
  logoSvg?: string;
}

interface Props {
  spaces?: Space[];
  spaceName?: string;
  modelValue?: string | null;
  canAccessSettings?: boolean;
  canCreateDocs?: boolean;
  loading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  spaces: () => [],
  modelValue: null,
  canAccessSettings: false,
  canCreateDocs: false,
  loading: false,
});

const emit = defineEmits<{
  "update:modelValue": [value: string];
  select: [space: Space];
  settings: [];
  create: [data: { name: string; slug: string; brandColor: string }];
  createDoc: [];
}>();

const currentSpace = computed(() => {
  if (props.modelValue) {
    return props.spaces.find((s) => s.id === props.modelValue) || props.spaces[0] || null;
  }
  return props.spaces[0] || null;
});

const handleSpaceSelect = (space: Space) => {
  emit("update:modelValue", space.id);
  emit("select", space);
};

const handleSettings = (event: Event) => {
  event.stopPropagation();
  emit("settings");
};

const handleCreateClick = (e: Event) => {
  emit("create", {
    name: "",
    slug: "",
    brandColor: "",
  });
  e.target?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
};

const handleCreateDoc = (event: Event) => {
  event.stopPropagation();
  emit("createDoc");
};
</script>

<template>
  <div class="w-full flex gap-4 pr-4xs">
    <div v-if="loading" class="flex items-center gap-3xs px-4xs py-4xs">
      <div class="flex-none w-9 h-9 bg-neutral-200 rounded-md animate-pulse" />
      <div class="flex-1 flex flex-col gap-1">
        <div class="h-4 bg-neutral-200 rounded animate-pulse w-28" />
        <div class="h-3 bg-neutral-100 rounded animate-pulse w-16" />
      </div>
    </div>
    
    <a-popover-trigger v-else class="block w-full group relative z-10 overflow-hidden">
      <button slot="trigger" class="w-full">
        <div class="flex items-center gap-3xs px-4xs py-4xs rounded-md transition-colors hover:bg-primary-100 group-[[opened]]:bg-primary-50">
          <div class="flex w-full gap-3xs cursor-pointer">
            <!-- Space Icon -->
            <div class="flex-none w-9 rounded-md flex items-center justify-center bg-primary-500 overflow-hidden" :style="{ background: currentSpace?.color }">
              <div v-if="currentSpace?.logoSvg && currentSpace.logoSvg.startsWith('<')" v-html="currentSpace.logoSvg" class="text-white" />
              <img v-else-if="currentSpace?.logoSvg" :src="currentSpace.logoSvg" class="w-full h-full object-contain" />
              <div v-else v-html="homeIcon" class="text-white" />
            </div>
  
            <!-- Space Info -->
            <div class="relative h-9 flex-1 text-left">
              <div class="left-0 w-full h-full">
                <div class="whitespace-nowrap text-base leading-[1.35em] font-normal text-foreground overflow-hidden text-ellipsis">
                  {{ currentSpace?.name || spaceName || 'Select Space' }}
                </div>
                <div class="whitespace-nowrap text-label leading-[1.35em] text-neutral-600 overflow-hidden text-ellipsis">
                  {{ currentSpace?.members || 0 }} Members
                </div>
              </div>
            </div>
          </div>
        </div>
      </button>
  
      <a-popover class="group" placements="bottom">
        <div class="w-max opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100">
          <div class="bg-neutral-50 border border-neutral-100 rounded-lg origin-top scale-95 transition-all shadow-xl duration-150 group-[[enabled]]:scale-100 min-w-[240px] max-h-[500px] overflow-y-auto">
            <div class="p-[4px] flex flex-col gap-[4px]">
              <!-- Space List -->
              <button
                v-for="space in spaces"
                :key="space.id"
                type="button"
                @click="handleSpaceSelect(space)"
                class="flex items-center gap-2.5 px-3xs py-4xs w-full rounded-md transition-colors hover:bg-neutral-100 text-left"
                :class="{
                  'bg-primary-100': space.id === modelValue,
                }"
              >
                <div class="w-6 h-6 rounded overflow-hidden flex items-center justify-center" :style="{ background: space.color || '#6366f1' }">
                  <div v-if="space.logoSvg && space.logoSvg.startsWith('<')" v-html="space.logoSvg" class="block text-white" />
                  <img v-else-if="space.logoSvg" :src="space.logoSvg" class="block object-contain" />
                  <div v-else v-html="homeIcon" class="text-white [&>svg]:w-4 [&>svg]:h-4 [&>svg]:object-contain" />
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-interactive font-medium text-foreground truncate">
                    {{ space.name }}
                  </div>
                </div>
              </button>
  
              <!-- Create Space Button -->
              <div class="border-t border-neutral-100 pt-[4px] mt-[4px]">
                <button
                  type="button"
                  @click="handleCreateClick"
                  class="flex items-center gap-2.5 px-3xs py-4xs w-full rounded-md transition-colors hover:bg-neutral-100 text-neutral-500"
                >
                  <Icon name="plus" />
                  <span class="text-interactive leading-none font-medium">
                    Create new space
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </a-popover>
    </a-popover-trigger>
    
    <!-- Action Buttons -->
    <div class="@max-sm:hidden flex items-center gap-2xs flex-none">
      <ButtonSecondary
        v-if="props.canAccessSettings"
        aria-label="Space settings"
        @click="handleSettings"
        :icon="settingsIcon"
      />
      <ButtonSecondary v-if="props.canCreateDocs" aria-label="New document" @click="handleCreateDoc">
        <Icon name="plus" class="-mx-1" />
      </ButtonSecondary>
    </div>
  </div>
</template>
