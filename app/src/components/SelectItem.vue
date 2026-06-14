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

const emit = defineEmits<{
  click: [];
}>();

const handleClick = () => {
  emit("click");
};
</script>

<template>
  <button type="button" class="flex items-center gap-2.5 px-3xs py-4xs w-full rounded-md transition-colors text-left" :class="{
    'bg-primary-50': selected,
    'hover:bg-primary-10': !selected,
  }" @click="handleClick">
    <div v-if="icon" v-html="icon" class="w-[18px] h-[18px] shrink-0" />
    <span class="text-size-normal font-normal text-neutral-950 capitalize">
      {{ label }}
    </span>
  </button>
</template>

<style scoped>
button :deep(svg) {
  width: 18px;
  height: 18px;
  color: var(--color-neutral-950);
}
</style>
