<template>
  <div>
    <!-- Scheduled Jobs -->
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-size-medium font-semibold text-neutral-900">Scheduled Jobs</h2>
      <button v-if="!isCreatingSchedule" @click="handleStartCreateSchedule"
        class="text-size-small text-blue-600 hover:text-blue-800 font-medium">+ Add Schedule</button>
    </div>

    <div v-if="scheduleError" class="mb-3 p-2 bg-red-50 border border-red-200 rounded-sm text-size-medium text-red-600">
      {{ scheduleError }}
    </div>

    <!-- Create Schedule Form -->
    <div v-if="isCreatingSchedule" class="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
      <form @submit.prevent="handleCreateSchedule" class="space-y-3">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label class="block text-size-small font-medium text-neutral-700 mb-1">Job</label>
            <select v-model="newScheduleJobId" required
              class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="" disabled>{{ availableJobs.length > 0 ? 'Select job' : 'No jobs available' }}</option>
              <option v-for="job in availableJobs" :key="job.id" :value="job.id">
                {{ job.name }} ({{ job.extensionName }})
              </option>
            </select>
          </div>
          <div>
            <label class="block text-size-small font-medium text-neutral-700 mb-1">Cron Expression</label>
            <input v-model="newScheduleCron" type="text" required placeholder="e.g. 0 6 * * 1"
              class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono" />
            <p class="mt-0.5 text-size-small text-neutral-500">minute hour day month weekday</p>
          </div>
          <div>
            <label class="block text-size-small font-medium text-neutral-700 mb-1">Timezone <span class="text-neutral-400 font-normal">(optional)</span></label>
            <input v-model="newScheduleTimezone" type="text" placeholder="e.g. Europe/Berlin"
              class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <button type="button" @click="handleCancelCreateSchedule"
            class="px-3 py-1.5 text-size-medium text-neutral-600 hover:text-neutral-800">Cancel</button>
          <button type="submit" :disabled="isSubmittingSchedule || !newScheduleJobId"
            class="px-3 py-1.5 text-size-medium font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50">
            {{ isSubmittingSchedule ? 'Creating...' : 'Create Schedule' }}
          </button>
        </div>
      </form>
    </div>

    <div v-if="isLoadingSchedules" class="text-center py-6 text-size-medium text-neutral-500">Loading schedules...</div>
    <div v-else-if="schedules.length === 0 && !isCreatingSchedule" class="text-center py-6 text-size-medium text-neutral-500">
      No scheduled jobs
    </div>
    <div v-else-if="schedules.length > 0" class="overflow-x-auto border border-neutral-100 rounded-md">
      <table class="min-w-full text-size-medium">
        <thead class="bg-neutral-50">
          <tr>
            <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Job</th>
            <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Schedule</th>
            <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Next Run</th>
            <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Last Run</th>
            <th class="px-4 py-2.5 text-right text-size-small font-medium text-neutral-500 uppercase tracking-wide">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-neutral-100">
          <tr v-for="schedule in schedules" :key="schedule.id" class="hover:bg-neutral-50">
            <td class="px-4 py-2.5">
              <div class="flex items-center gap-2">
                <span :class="schedule.enabled ? 'bg-green-500' : 'bg-neutral-300'" class="w-2 h-2 rounded-full shrink-0"></span>
                <span class="font-medium text-neutral-900">{{ jobName(schedule.jobId) }}</span>
              </div>
            </td>
            <td class="px-4 py-2.5 whitespace-nowrap">
              <code class="px-1.5 py-0.5 text-size-small bg-neutral-100 rounded-sm font-mono">{{ schedule.cronExpression }}</code>
              <span v-if="schedule.timezone" class="ml-1 text-size-small text-neutral-400">{{ schedule.timezone }}</span>
            </td>
            <td class="px-4 py-2.5 whitespace-nowrap text-neutral-500">{{ schedule.enabled && schedule.nextRunAt ? formatDateTime(schedule.nextRunAt) : '—' }}</td>
            <td class="px-4 py-2.5 whitespace-nowrap text-neutral-500">{{ schedule.lastRunAt ? formatDateTime(schedule.lastRunAt) : '—' }}</td>
            <td class="px-4 py-2.5 whitespace-nowrap text-right space-x-2">
              <button @click="handleToggleSchedule(schedule)" class="text-size-small text-blue-600 hover:text-blue-800">
                {{ schedule.enabled ? 'Disable' : 'Enable' }}
              </button>
              <button @click="handleDeleteSchedule(schedule.id)" class="text-size-small text-red-600 hover:text-red-800">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Recent Job Runs -->
    <div class="mt-8 pt-6 border-t border-neutral-100">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-size-medium font-semibold text-neutral-900">Recent Job Runs</h2>
        <button @click="refreshRuns" :disabled="isLoadingRuns"
          class="text-size-small text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50">
          {{ isLoadingRuns ? 'Refreshing...' : 'Refresh' }}
        </button>
      </div>

      <div v-if="runsQueryError" class="mb-3 p-2 bg-red-50 border border-red-200 rounded-sm text-size-medium text-red-600">
        {{ runsQueryError?.message ?? 'Failed to load job runs' }}
      </div>

      <div v-if="isLoadingRuns && runs.length === 0" class="text-center py-6 text-size-medium text-neutral-500">Loading runs...</div>
      <div v-else-if="runs.length === 0" class="text-center py-6 text-size-medium text-neutral-500">No job runs yet</div>
      <div v-else class="overflow-x-auto border border-neutral-100 rounded-md">
        <table class="min-w-full text-size-medium">
          <thead class="bg-neutral-50">
            <tr>
              <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Status</th>
              <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Job</th>
              <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Trigger</th>
              <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Started</th>
              <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Duration</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-100">
            <template v-for="run in runs" :key="run.id">
              <tr class="hover:bg-neutral-50" :class="run.error ? 'cursor-pointer' : ''"
                @click="run.error ? (expandedRunId = expandedRunId === run.id ? null : run.id) : undefined">
                <td class="px-4 py-2.5 whitespace-nowrap">
                  <span :class="statusClasses(run.status)" class="px-1.5 py-0.5 text-size-small rounded-sm">{{ run.status }}</span>
                </td>
                <td class="px-4 py-2.5 font-medium text-neutral-900">{{ jobName(run.jobId) }}</td>
                <td class="px-4 py-2.5 whitespace-nowrap text-neutral-500">{{ run.trigger }}</td>
                <td class="px-4 py-2.5 whitespace-nowrap text-neutral-500">{{ formatDateTime(run.startedAt ?? run.queuedAt) }}</td>
                <td class="px-4 py-2.5 whitespace-nowrap text-neutral-500">{{ formatDuration(run) }}</td>
              </tr>
              <tr v-if="expandedRunId === run.id && run.error">
                <td colspan="5" class="px-4 py-2.5 bg-red-50">
                  <p class="text-size-small text-red-700 font-mono break-all">{{ run.error }}</p>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <Pager
        class="mt-3 pt-3"
        :page="runsPage"
        :total-pages="runsTotalPages"
        :disabled="isFetchingRuns"
        @change="runsGoToPage"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api, type JobRun, type JobSchedule } from "#api/client.ts";
import { usePagedList } from "#composeables/usePagedList.ts";
import { useSpace } from "#composeables/useSpace.ts";
import Pager from "./Pager.vue";

const { currentSpace } = useSpace();

// Schedules state
const schedules = ref<JobSchedule[]>([]);
const isLoadingSchedules = ref(false);
const scheduleError = ref<string | null>(null);
const isCreatingSchedule = ref(false);
const isSubmittingSchedule = ref(false);
const newScheduleJobId = ref("");
const newScheduleCron = ref("");
const newScheduleTimezone = ref("");

// Available jobs from extension manifests, for the create form and name lookup
interface AvailableJob {
  id: string;
  name: string;
  extensionName: string;
}
const availableJobs = ref<AvailableJob[]>([]);

const {
  items: runs,
  isLoading: isLoadingRuns,
  isFetching: isFetchingRuns,
  error: runsQueryError,
  page: runsPage,
  totalPages: runsTotalPages,
  goToPage: runsGoToPage,
  refresh: refreshRuns,
} = usePagedList({
  queryKey: computed(() => ["job_runs", currentSpace.value?.id]),
  fetcher: ({ limit, offset }) =>
    api.jobs.listRuns(currentSpace.value?.id, { limit, offset }).then((r) => ({
      items: r.runs,
      total: r.total,
    })),
  enabled: computed(() => !!currentSpace.value?.id),
  pageSize: 25,
});

const expandedRunId = ref<string | null>(null);

function jobName(jobId: string): string {
  return availableJobs.value.find((j) => j.id === jobId)?.name ?? jobId;
}

function statusClasses(status: JobRun["status"]): string {
  switch (status) {
    case "success":
      return "bg-green-100 text-green-700";
    case "failed":
    case "timeout":
      return "bg-red-100 text-red-700";
    case "cancelled":
      return "bg-yellow-100 text-yellow-700";
    case "running":
      return "bg-blue-100 text-blue-700";
    default:
      return "bg-neutral-100 text-neutral-600";
  }
}

function formatDateTime(date: Date | string): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(run: JobRun): string {
  if (!run.startedAt) return "—";
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  const ms = end - new Date(run.startedAt).getTime();
  if (ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

async function loadAvailableJobs() {
  if (!currentSpace.value?.id) return;
  try {
    const { extensions } = await api.extensions.get(currentSpace.value.id);
    availableJobs.value = extensions.flatMap(
      (ext) =>
        ext.jobs?.map((job) => ({
          id: job.id,
          name: job.name,
          extensionName: ext.name,
        })) ?? [],
    );
  } catch {
    availableJobs.value = [];
  }
}

async function loadSchedules() {
  if (!currentSpace.value?.id) return;
  isLoadingSchedules.value = true;
  scheduleError.value = null;
  try {
    const response = await api.jobs.listSchedules(currentSpace.value.id);
    schedules.value = response.schedules || [];
  } catch (err) {
    scheduleError.value = err instanceof Error ? err.message : "Failed to load schedules";
  } finally {
    isLoadingSchedules.value = false;
  }
}

function handleStartCreateSchedule() {
  isCreatingSchedule.value = true;
  newScheduleJobId.value = "";
  newScheduleCron.value = "";
  newScheduleTimezone.value = "";
  scheduleError.value = null;
}

function handleCancelCreateSchedule() {
  isCreatingSchedule.value = false;
  scheduleError.value = null;
}

async function handleCreateSchedule() {
  if (!currentSpace.value?.id || !newScheduleJobId.value || !newScheduleCron.value.trim())
    return;
  isSubmittingSchedule.value = true;
  scheduleError.value = null;
  try {
    await api.jobs.createSchedule(currentSpace.value.id, {
      jobId: newScheduleJobId.value,
      cronExpression: newScheduleCron.value.trim(),
      ...(newScheduleTimezone.value.trim()
        ? { timezone: newScheduleTimezone.value.trim() }
        : {}),
    });
    isCreatingSchedule.value = false;
    await loadSchedules();
  } catch (err) {
    scheduleError.value =
      err instanceof Error ? err.message : "Failed to create schedule";
  } finally {
    isSubmittingSchedule.value = false;
  }
}

async function handleToggleSchedule(schedule: JobSchedule) {
  if (!currentSpace.value?.id) return;
  scheduleError.value = null;
  try {
    await api.jobs.updateSchedule(currentSpace.value.id, schedule.id, {
      enabled: !schedule.enabled,
    });
    await loadSchedules();
  } catch (err) {
    scheduleError.value =
      err instanceof Error ? err.message : "Failed to update schedule";
  }
}

async function handleDeleteSchedule(scheduleId: string) {
  if (!currentSpace.value?.id) return;
  if (!confirm("Delete this schedule? Run history is preserved.")) return;
  scheduleError.value = null;
  try {
    await api.jobs.deleteSchedule(currentSpace.value.id, scheduleId);
    await loadSchedules();
  } catch (err) {
    scheduleError.value =
      err instanceof Error ? err.message : "Failed to delete schedule";
  }
}

function loadAll() {
  loadAvailableJobs();
  loadSchedules();
}

onMounted(loadAll);

watch(
  () => currentSpace.value?.id,
  (id) => {
    if (id) loadAll();
  },
);
</script>
