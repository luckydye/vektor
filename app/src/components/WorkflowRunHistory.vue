<script setup lang="ts">
import { spinnerIcon } from "#assets/icons.ts";
import { formatDateTime } from "#utils/datetime.ts";
import PagerCursor from "./PagerCursor.vue";

type RunSummary = {
  runId: string;
  status: string;
  createdAt: string;
  runtimeInputs: Record<string, unknown>;
};

defineProps<{
  runs: RunSummary[];
  selectedRunId: string | null;
  hasPrevPage: boolean;
  hasNextPage: boolean;
  busy?: boolean;
}>();

const emit = defineEmits<{
  select: [runId: string];
  prev: [];
  next: [];
}>();

function runTitle(run: RunSummary): string {
  const title = run.runtimeInputs?.title;
  return typeof title === "string" && title ? title : "Untitled";
}

const statusBadgeClass: Record<string, string> = {
  pending: "bg-neutral-100 text-neutral-500",
  running: "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400",
  completed:
    "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400",
  failed: "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400",
  cancelled: "bg-neutral-100 text-neutral-400",
};
</script>

<template>
  <section class="min-w-0">
    <div v-if="runs.length > 0 || hasPrevPage" class="space-y-1">
      <button
        v-for="run in runs"
        :key="run.runId"
        type="button"
        class="flex w-full min-w-0 flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors"
        :class="selectedRunId === run.runId
          ? 'border-primary-300 bg-primary-50'
          : 'border-transparent hover:bg-neutral-50 dark:hover:bg-neutral-100'"
        :aria-current="selectedRunId === run.runId ? 'true' : undefined"
        @click="emit('select', run.runId)"
      >
        <span
          class="w-full truncate text-size-medium font-medium text-neutral-800"
          :title="runTitle(run)"
        >
          {{ runTitle(run) }}
        </span>
        <span class="flex w-full items-center justify-between gap-2">
          <span class="text-size-small text-neutral-400 tabular-nums truncate">
            {{ formatDateTime(run.createdAt) }}
          </span>
          <span
            class="inline-flex flex-none items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-medium capitalize"
            :class="statusBadgeClass[run.status] ?? 'bg-neutral-100 text-neutral-500'"
          >
            <span
              v-if="run.status === 'running' || run.status === 'pending'"
              class="svg-icon w-2.5 h-2.5 animate-spin"
              v-html="spinnerIcon"
            />
            {{ run.status }}
          </span>
        </span>
      </button>

      <PagerCursor
        class="mt-2 pt-2"
        alwaysVisible
        :hasPrevPage="hasPrevPage"
        :hasNextPage="hasNextPage"
        :disabled="busy"
        @prev="emit('prev')"
        @next="emit('next')"
      />
    </div>

    <p v-else class="text-size-medium text-neutral-400">No runs yet.</p>
  </section>
</template>
