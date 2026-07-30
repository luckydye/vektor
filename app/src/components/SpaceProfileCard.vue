<script setup lang="ts">
import "@atrium-ui/elements/color-picker";
import "@atrium-ui/elements/popover";
import { editEntryIcon } from "#assets/icons.ts";
import Button from "./Button.vue";

interface Props {
  name: string;
  slug: string;
  brandColor: string;
  logo: string;
  description?: string;
}

const props = withDefaults(defineProps<Props>(), {
  description: "",
});

const emit = defineEmits<{
  "update:brandColor": [value: string];
  "logo-upload": [event: Event];
  "remove-logo": [];
}>();

function handleBrandColorChange(event: Event) {
  emit("update:brandColor", (event.target as HTMLElement & { value: string }).value);
}
</script>

<template>
  <div class="rounded-xl border border-neutral-200 overflow-hidden">
    <a-popover-trigger showdelay="0" hidedelay="100" class="block">
      <div
        slot="trigger"
        class="relative h-24 w-full cursor-pointer group transition-colors duration-300"
        :style="{ backgroundColor: props.brandColor }"
        title="Change color"
      >
        <div
          class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20"
        >
          <span class="text-[11px] font-medium text-white drop-shadow">
            Change color
          </span>
        </div>
      </div>
      <a-popover class="group" placements="bottom-start">
        <div
          class="w-max py-2 opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100"
        >
          <div
            class="bg-background border border-neutral-100 rounded-lg p-2 origin-top-left scale-95 transition-all shadow-large duration-150 group-[&[enabled]]:scale-100"
          >
            <a-color-picker
              class="w-[220px]"
              :value="props.brandColor"
              @change="handleBrandColorChange"
            ></a-color-picker>
          </div>
        </div>
      </a-popover>
    </a-popover-trigger>

    <div class="px-3 pb-3">
      <div class="-mt-8 mb-2.5 flex items-end gap-1.5">
        <!-- biome-ignore lint/a11y/noLabelWithoutControl: The Vue template control association is resolved by the rendered component. -->
        <label
          class="relative w-16 h-16 rounded-xl border-2 border-white shadow-sm flex items-center justify-center overflow-hidden cursor-pointer group"
          :style="{ backgroundColor: props.brandColor }"
          title="Change logo"
        >
          <input
            type="file"
            accept="image/svg+xml,image/png,image/jpeg"
            class="sr-only"
            @change="emit('logo-upload', $event)"
          >
          <template v-if="props.logo">
            <div
              v-if="props.logo.startsWith('<')"
              v-html="props.logo"
              class="w-full h-full p-1.5 [&>svg]:w-full [&>svg]:h-full"
            />
            <img v-else :src="props.logo" alt="" class="w-full h-full object-cover">
          </template>
          <span v-else class="text-sm font-bold text-white select-none leading-none">
            {{ (props.name || '?')[0].toUpperCase() }}
          </span>
          <div
            class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30 rounded-lg"
          >
            <div class="svg-icon w-4 h-4 text-white" v-html="editEntryIcon" />
          </div>
        </label>
        <Button
          variant="secondary"
          v-if="props.logo"
          text="Remove"
          @click="emit('remove-logo')"
        />
      </div>

      <p class="text-size-medium font-semibold text-neutral-900 leading-snug truncate">
        {{ props.name || 'Untitled Space' }}
      </p>
      <p
        v-if="props.description"
        class="text-size-small text-neutral-500 mt-0.5 line-clamp-2 leading-snug"
      >
        {{ props.description }}
      </p>
      <p class="text-[11px] text-neutral-400 mt-1 font-mono truncate">
        {{ props.slug || 'space-slug' }}
      </p>
    </div>
  </div>
</template>
