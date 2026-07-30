<script setup lang="ts">
interface Props {
  icon?: string;
  label?: string;
  selected?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  label: "Item",
  selected: false,
});
</script>

<template>
  <button
    type="button"
    class="flex items-center gap-2.5 px-3xs py-4xs w-full rounded-md transition-colors text-left [&_svg]:w-[18px] [&_svg]:h-[18px] [&_svg]:text-neutral-950"
    :class="{
    'bg-primary-50': selected,
    'hover:bg-primary-10': !selected,
  }"
  >
    <div v-if="icon" v-html="icon" class="w-[18px] h-[18px] shrink-0" />
    <span class="text-size-normal font-normal text-neutral-950 capitalize leading-[1rem]">
      {{ label }}
    </span>
  </button>
</template>
