<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ButtonPrimary, ButtonSecondary, Dialog } from "~/src/components/index.ts";

export interface ExcelExportConfig {
  sheetNameColumn: string;
  splitColumn: string;
  delimiter: string;
  parseBoldHeadings: boolean;
  summaryColumnCount: number;
}

const props = defineProps<{
  columns: string[];
  rowCount: number;
}>();

const emit = defineEmits<{
  cancel: [];
  download: [config: ExcelExportConfig];
}>();

const sheetNameColumn = ref(props.columns[0] ?? "");
const splitColumn = ref(props.columns[props.columns.length - 1] ?? "");
const delimiter = ref("---");
const parseBoldHeadings = ref(true);
const summaryColumnCount = ref(Math.min(5, props.columns.length));

watch(
  () => props.columns,
  (cols) => {
    if (!cols.includes(sheetNameColumn.value)) sheetNameColumn.value = cols[0] ?? "";
    if (!cols.includes(splitColumn.value))
      splitColumn.value = cols[cols.length - 1] ?? "";
  },
);

const sheetCount = computed(() => props.rowCount);

function submit() {
  emit("download", {
    sheetNameColumn: sheetNameColumn.value,
    splitColumn: splitColumn.value,
    delimiter: delimiter.value,
    parseBoldHeadings: parseBoldHeadings.value,
    summaryColumnCount: summaryColumnCount.value,
  });
}
</script>

<template>
  <Dialog
    :show="true"
    title="Export to Excel"
    max-width="md:max-w-sm"
    @update:show="emit('cancel')"
  >
    <div class="flex flex-col gap-xs">
      <p class="text-size-small text-neutral-500">
        Creates an Overview sheet plus one sub-sheet per row. Long cell content is split
        into rows by the delimiter.
      </p>

      <div class="flex flex-col gap-3xs">
        <label class="flex flex-col gap-4xs">
          <span class="text-size-small font-medium text-neutral-700"
            >Sheet name column</span
          >
          <span class="text-size-small text-neutral-400"
            >Column value used as the tab name for each sub-sheet</span
          >
          <select
            v-model="sheetNameColumn"
            class="rounded-sm border border-neutral-200 bg-background px-2 py-1 text-size-small text-neutral-700 focus:outline-none focus:border-primary-400"
          >
            <option v-for="col in columns" :key="col" :value="col">{{ col }}</option>
          </select>
        </label>

        <label class="flex flex-col gap-4xs">
          <span class="text-size-small font-medium text-neutral-700">Split column</span>
          <span class="text-size-small text-neutral-400"
            >Column whose content is split into rows within the sub-sheet</span
          >
          <select
            v-model="splitColumn"
            class="rounded-sm border border-neutral-200 bg-background px-2 py-1 text-size-small text-neutral-700 focus:outline-none focus:border-primary-400"
          >
            <option v-for="col in columns" :key="col" :value="col">{{ col }}</option>
          </select>
        </label>

        <label class="flex flex-col gap-4xs">
          <span class="text-size-small font-medium text-neutral-700">Delimiter</span>
          <span class="text-size-small text-neutral-400"
            >Split the content on this string (e.g.
            <code class="font-mono bg-neutral-100 px-1 rounded-xs">---</code>)</span
          >
          <input
            v-model="delimiter"
            type="text"
            placeholder="---"
            class="rounded-sm border border-neutral-200 bg-background px-2 py-1 text-size-small font-mono text-neutral-700 focus:outline-none focus:border-primary-400"
          >
        </label>

        <label class="flex items-center gap-2xs cursor-pointer select-none">
          <input
            v-model="parseBoldHeadings"
            type="checkbox"
            class="rounded-xs accent-primary-600"
          >
          <span class="text-size-small font-medium text-neutral-700"
            >Parse
            <code class="font-mono bg-neutral-100 px-1 rounded-xs"
              >**bold headings**</code
            >
            as columns</span
          >
        </label>

        <label class="flex flex-col gap-4xs">
          <span class="text-size-small font-medium text-neutral-700"
            >Summary columns</span
          >
          <span class="text-size-small text-neutral-400"
            >Number of leading columns included in the summary block above the split rows</span
          >
          <input
            v-model.number="summaryColumnCount"
            type="number"
            min="0"
            :max="columns.length"
            class="rounded-sm border border-neutral-200 bg-background px-2 py-1 text-size-small text-neutral-700 focus:outline-none focus:border-primary-400"
          >
        </label>
      </div>

      <p class="text-size-small text-neutral-400">
        {{ sheetCount }}
        sub-sheet{{ sheetCount === 1 ? '' : 's' }}
        will be created (one per row in current filter).
      </p>
    </div>

    <template #footer>
      <div class="flex items-center justify-end gap-2xs">
        <ButtonSecondary text="Cancel" @click="emit('cancel')" />
        <ButtonPrimary
          text="Download"
          :disabled="!sheetNameColumn || !splitColumn"
          @click="submit"
        />
      </div>
    </template>
  </Dialog>
</template>
