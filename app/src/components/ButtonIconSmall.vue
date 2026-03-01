<script setup lang="ts">
interface Props {
  icon?: string;
}

const props = withDefaults(defineProps<Props>(), {});
</script>

<template>
  <div>
    <button type="button"
      class="cursor-pointer inline-flex items-center justify-center gap-5xs bg-background border border-primary-100 rounded-md h-[28px] px-4xs hover:bg-primary-10 active:bg-primary-50 transition-colors text-primary-400">
      <div v-html="icon" />
    </button>
  </div>
</template>

<style scoped>
button :deep(svg) {
  width: 18px;
  height: 18px;
  color: inherit;
}
</style>
