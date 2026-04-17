<script setup lang="ts">
import { ref, computed, watch } from "vue";

const PAGE_SIZE = 10;

const props = defineProps<{
  data: Record<string, unknown>[];
}>();

const filter = ref("");
const page = ref(0);

watch(filter, () => { page.value = 0; });

const columns = computed(() => {
  if (props.data.length === 0) return [];
  return Object.keys(props.data[0]);
});

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return props.data;
  return props.data.filter((row) =>
    Object.values(row).some((v) => String(v ?? "").toLowerCase().includes(q)),
  );
});

const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)));
const paginated = computed(() => filtered.value.slice(page.value * PAGE_SIZE, (page.value + 1) * PAGE_SIZE));

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
</script>

<template>
  <div class="space-y-2">
    <input
      v-model="filter"
      type="text"
      placeholder="Filter…"
      class="w-full rounded-md border border-neutral-200 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-400"
    />
    <div class="overflow-x-auto rounded-lg border border-neutral-200">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-neutral-50 dark:bg-neutral-800 text-left">
            <th
              v-for="col in columns"
              :key="col"
              class="px-3 py-2 text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide whitespace-nowrap border-b border-neutral-200 min-w-[200px]"
            >{{ col }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, i) in paginated"
            :key="i"
            class="border-b border-neutral-100 dark:border-neutral-800 last:border-0 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
          >
            <td
              v-for="col in columns"
              :key="col"
              class="px-3 py-2 text-neutral-700 dark:text-neutral-300 whitespace-nowrap min-w-[200px] max-w-xs truncate"
              :title="cellText(row[col])"
            >{{ cellText(row[col]) }}</td>
          </tr>
          <tr v-if="filtered.length === 0">
            <td :colspan="columns.length" class="px-3 py-4 text-center text-xs text-neutral-400">No results</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="flex items-center justify-between text-xs text-neutral-400">
      <span>{{ filtered.length }} / {{ data.length }} rows</span>
      <div v-if="pageCount > 1" class="flex items-center gap-1">
        <button
          class="px-2 py-0.5 rounded border border-neutral-200 hover:bg-neutral-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          :disabled="page === 0"
          @click="page--"
        >←</button>
        <span>{{ page + 1 }} / {{ pageCount }}</span>
        <button
          class="px-2 py-0.5 rounded border border-neutral-200 hover:bg-neutral-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          :disabled="page >= pageCount - 1"
          @click="page++"
        >→</button>
      </div>
    </div>
  </div>
</template>
