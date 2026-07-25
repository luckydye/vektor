<script setup lang="ts">
interface Props {
  icon?: string;
  ariaLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {});
</script>

<template>
  <div>
    <button
      type="button"
      :aria-label="props.ariaLabel"
      :title="props.ariaLabel"
      class="cursor-pointer flex items-center justify-center gap-5xs bg-background border border-primary-100 rounded-md h-[28px] px-4xs hover:bg-primary-10 active:bg-primary-50 transition-colors text-primary-400 [&_svg]:w-[18px] [&_svg]:h-[18px] [&_svg]:text-inherit"
    >
      <div v-html="icon" />
    </button>
  </div>
</template>
