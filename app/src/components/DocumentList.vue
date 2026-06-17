<script setup lang="ts">
import { computed, ref, watchEffect } from "vue";
import { archiveIcon, closeXIcon } from "~/src/assets/icons.ts";

const props = defineProps<{
  items: Array<{ id: string }>;
  canBatchArchive?: boolean;
  isBatchArchiving?: boolean;
}>();

const emit = defineEmits<{
  "batch-archive": [ids: string[]];
}>();

const headerCheckboxRef = ref<HTMLInputElement | null>(null);
const selectedIds = ref<Set<string>>(new Set());

const allSelected = computed(
  () => props.items.length > 0 && props.items.every((item) => selectedIds.value.has(item.id)),
);
const someSelected = computed(() => selectedIds.value.size > 0 && !allSelected.value);
const selectable = computed(() => selectedIds.value.size > 0);

watchEffect(() => {
  if (headerCheckboxRef.value) {
    headerCheckboxRef.value.indeterminate = someSelected.value;
  }
});

const toggleSelect = (id: string) => {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
};

const toggleSelectAll = () => {
  if (allSelected.value) {
    selectedIds.value = new Set();
  } else {
    selectedIds.value = new Set(props.items.map((item) => item.id));
  }
};

const deselectAll = () => {
  selectedIds.value = new Set();
};
</script>

<template>
  <div>
    <!-- Sticky header -->
    <div
      class="grid grid-cols-[32px_1fr_80px_200px_140px] items-center h-9 border-b border-neutral-100 sticky top-0 z-10 transition-colors"
      :class="selectedIds.size > 0 ? 'bg-primary-50' : 'bg-background'"
    >
      <div class="flex items-center justify-center">
        <input
          ref="headerCheckboxRef"
          type="checkbox"
          :checked="allSelected"
          @change="toggleSelectAll"
          class="w-3.5 h-3.5 accent-primary-500 cursor-pointer"
        />
      </div>
      <!-- Column labels -->
      <template v-if="selectedIds.size === 0">
        <div class="text-[11px] font-medium text-neutral uppercase tracking-wider">
          <slot name="header-label" />
        </div>
        <div class="text-[11px] font-medium text-neutral uppercase tracking-wider">Type</div>
        <div class="text-[11px] font-medium text-neutral uppercase tracking-wider">Properties</div>
        <div class="pr-4 text-right text-[11px] font-medium text-neutral uppercase tracking-wider">Modified</div>
      </template>
      <!-- Batch toolbar -->
      <div v-else class="col-span-4 flex items-center gap-2 pr-4">
        <span class="text-size-small font-medium text-primary-700">{{ selectedIds.size }} selected</span>
        <button
          @click="deselectAll"
          class="p-0.5 text-neutral hover:text-neutral-800 hover:bg-neutral-200 rounded-sm transition-colors"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="closeXIcon" />
        </button>
        <div class="flex-1" />
        <slot name="batch-actions" :selected-ids="selectedIds" :deselect-all="deselectAll" />
        <button
          v-if="canBatchArchive"
          @click="emit('batch-archive', [...selectedIds])"
          :disabled="isBatchArchiving"
          class="flex items-center gap-1.5 px-3 py-1 bg-background border border-neutral-100 rounded-md text-size-small text-neutral-700 hover:border-neutral-300 hover:text-neutral-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="archiveIcon" />
          {{ isBatchArchiving ? "Archiving…" : "Archive" }}
        </button>
      </div>
    </div>

    <!-- Rows -->
    <slot :selected-ids="selectedIds" :toggle-select="toggleSelect" :selectable="selectable" />
  </div>
</template>
