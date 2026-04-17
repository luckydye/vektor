<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { api } from "../api/client.ts";
import { normalizeTimestamp } from "../utils/utils.ts";

type WorkflowRun = {
  runId: string;
  documentId: string;
  documentSlug: string | null;
  documentTitle: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  totalNodes: number;
  completedNodes: number;
  runtimeInputs: Record<string, unknown>;
};

const props = defineProps<{
  spaceSlug: string;
  spaceId: string;
}>();

const runs = ref<WorkflowRun[]>([]);
const now = ref(Date.now());
let pollInterval: ReturnType<typeof setInterval> | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;

async function fetchRuns() {
  const result = await api.workflows.listRuns(props.spaceId);
  runs.value = (result as WorkflowRun[])
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);
}

onMounted(() => {
  fetchRuns();
  pollInterval = setInterval(fetchRuns, 3000);
  tickInterval = setInterval(() => { now.value = Date.now(); }, 1000);
});

onUnmounted(() => {
  if (pollInterval !== null) clearInterval(pollInterval);
  if (tickInterval !== null) clearInterval(tickInterval);
});

function docHref(run: WorkflowRun): string {
  if (run.documentSlug) return `/${props.spaceSlug}/doc/${run.documentSlug}`;
  return `/${props.spaceSlug}`;
}

function isActive(run: WorkflowRun): boolean {
  return run.status === "pending" || run.status === "running";
}

const statusGradients: Record<string, string> = {
  completed: "bg-[linear-gradient(145deg,rgba(16,185,129,0.12)_0%,rgba(5,150,105,0.06)_40%,transparent_75%)]",
  running: "bg-[linear-gradient(145deg,rgba(14,165,233,0.14)_0%,rgba(37,99,235,0.07)_40%,transparent_75%)]",
  failed: "bg-[linear-gradient(145deg,rgba(244,63,94,0.12)_0%,rgba(225,29,72,0.06)_40%,transparent_75%)]",
  pending: "bg-[linear-gradient(145deg,rgba(148,163,184,0.1)_0%,rgba(100,116,139,0.05)_40%,transparent_75%)]",
};

const statusBadgeColors: Record<string, string> = {
  completed: "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400",
  running: "border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-400",
  failed: "border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-400",
  pending: "border-neutral-200 bg-neutral-100 text-neutral-500",
  cancelled: "border-neutral-200 bg-neutral-100 text-neutral-400",
};

function statusGradient(status: string): string {
  return statusGradients[status] ?? statusGradients.pending;
}

function statusBadge(status: string): string {
  return statusBadgeColors[status] ?? statusBadgeColors.pending;
}

function durationMs(start: string, end: number | string): number {
  return (typeof end === "number" ? end : new Date(end).getTime()) - new Date(start).getTime();
}

function formatMs(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function durationLabel(run: WorkflowRun): string {
  const start = run.startedAt ?? run.createdAt;
  if (isActive(run)) return `Running for ${formatMs(durationMs(start, now.value))}`;
  if (run.finishedAt) return `Duration ${formatMs(durationMs(start, run.finishedAt))}`;
  return "";
}

function startedAtLabel(run: WorkflowRun): string {
  const start = run.startedAt ?? run.createdAt;
  return "Started " + new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(start));
}

function fullTimestamp(iso: string): string {
  return new Date(iso).toLocaleString([], {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

const groupedRuns = computed(() => {
  const groups: { date: string; items: WorkflowRun[] }[] = [];
  let currentDate = "";
  let currentGroup: WorkflowRun[] = [];

  for (const run of runs.value) {
    const date = normalizeTimestamp(run.createdAt).toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
    if (date !== currentDate) {
      if (currentGroup.length > 0) groups.push({ date: currentDate, items: currentGroup });
      currentDate = date;
      currentGroup = [run];
    } else {
      currentGroup.push(run);
    }
  }
  if (currentGroup.length > 0) groups.push({ date: currentDate, items: currentGroup });
  return groups;
});
</script>

<template>
  <div v-if="runs.length > 0">
    <h2 class="text-lg font-semibold mb-3">Workflows</h2>
    <div class="space-y-6">
      <div v-for="group in groupedRuns" :key="group.date" class="space-y-3">
        <div class="text-xs font-semibold text-neutral-900 uppercase tracking-wide sticky top-0 py-2">
          {{ group.date }}
        </div>
        <div class="space-y-2">
      <a
        v-for="run in group.items"
        :key="run.runId"
        :href="docHref(run)"
        class="group relative flex flex-col overflow-hidden rounded-xl border border-neutral-200/80 bg-white dark:bg-neutral-100 p-0 shadow-[0_2px_8px_rgba(15,23,42,0.04)] hover:border-sky-300 dark:hover:border-neutral-300 transition-colors"
      >
        <!-- Status gradient -->
        <div class="absolute inset-0 pointer-events-none" :class="statusGradient(run.status)" />

        <div class="relative flex flex-col p-4">
          <!-- Top row: name + badge -->
          <div class="flex items-start justify-between gap-3 mb-3">
            <div class="min-w-0">
              <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-400 mb-1">Workflow</p>
              <h3 class="font-semibold text-[15px] leading-tight text-neutral-900 line-clamp-2">{{ run.runtimeInputs?.title ?? run.documentTitle }}</h3>
            </div>
            <span
              class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-semibold text-[11px] uppercase tracking-[0.08em] flex-shrink-0"
              :class="statusBadge(run.status)"
            >
              <svg v-if="run.status === 'running'" class="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              <span v-else class="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
              <span class="leading-none capitalize">{{ run.status }}</span>
            </span>
          </div>

          <!-- Progress bar -->
          <div v-if="run.totalNodes > 0" class="mb-3 flex items-center gap-2">
            <div class="flex-1 h-1 rounded-full bg-neutral-200 overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-500"
                :class="run.status === 'failed' ? 'bg-rose-400' : run.status === 'completed' ? 'bg-emerald-400' : 'bg-sky-400'"
                :style="{ width: `${Math.round((run.completedNodes / run.totalNodes) * 100)}%` }"
              />
            </div>
            <span class="text-[11px] text-neutral-400 tabular-nums whitespace-nowrap">
              {{ run.completedNodes }}/{{ run.totalNodes }}
            </span>
          </div>

          <!-- Bottom: time info -->
          <div class="flex justify-between mt-auto text-[11px] text-neutral-400" :title="fullTimestamp(run.createdAt)">
            <div>{{ startedAtLabel(run) }}</div>
            <div v-if="durationLabel(run)">{{ durationLabel(run) }}</div>
          </div>
        </div>
      </a>
        </div>
      </div>
    </div>
  </div>
</template>
