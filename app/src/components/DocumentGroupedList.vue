<script setup lang="ts">
import "@atrium-ui/elements/calendar";
import "@atrium-ui/elements/popover";
import { computed, onMounted, ref } from "vue";
import {
  calendarIcon,
  chevronDownIcon,
  clockIcon,
  closeXIcon,
  documentIcon,
} from "~/src/assets/icons.ts";
import type { Category, DocumentWithProperties } from "../api/client.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { formatDate, normalizeTimestamp, spacePath } from "../utils/utils.ts";

const props = defineProps<{
  items: DocumentWithProperties[];
  categories?: Category[];
  emptyText?: string;
  showToolbar?: boolean;
}>();

const { currentSpace } = useSpace();

defineSlots<{
  "batch-actions"(props: { selectedIds: Set<string>; deselectAll: () => void }): unknown;
  "row-actions"(props: { doc: DocumentWithProperties }): unknown;
}>();

onMounted(() => { import("~/src/editor/elements/page-target.ts"); });

// ── Category lookup ──────────────────────────────────────────────────────────

const categoryBySlug = computed(() => {
  const map = new Map<string, Category>();
  for (const c of props.categories ?? []) map.set(c.slug, c);
  return map;
});

// ── Filters & sort ───────────────────────────────────────────────────────────

const dateRangeStart = ref<Date | null>(null);
const dateRangeEnd = ref<Date | null>(null);

const dateRangeLabel = computed(() => {
  if (!dateRangeStart.value && !dateRangeEnd.value) return null;
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (dateRangeStart.value && dateRangeEnd.value) {
    return `${fmt(dateRangeStart.value)} – ${fmt(dateRangeEnd.value)}`;
  }
  return fmt((dateRangeStart.value ?? dateRangeEnd.value)!);
});

function onCalendarChange(e: Event) {
  const value = (e.target as HTMLElement & { value?: string }).value ?? "";
  if (!value) { dateRangeStart.value = null; dateRangeEnd.value = null; return; }
  const [start, end] = value.split("/");
  dateRangeStart.value = start ? new Date(start) : null;
  dateRangeEnd.value = end ? new Date(end) : null;
}

function clearDateRange() {
  dateRangeStart.value = null;
  dateRangeEnd.value = null;
}

const filtered = computed(() => {
  let docs = props.items;
  if (dateRangeStart.value) {
    const start = dateRangeStart.value.getTime();
    docs = docs.filter((d) => normalizeTimestamp(d.updatedAt).getTime() >= start);
  }
  if (dateRangeEnd.value) {
    // include the full end day
    const end = new Date(dateRangeEnd.value);
    end.setDate(end.getDate() + 1);
    docs = docs.filter((d) => normalizeTimestamp(d.updatedAt).getTime() < end.getTime());
  }
  return [...docs].sort(
    (a, b) => normalizeTimestamp(b.updatedAt).getTime() - normalizeTimestamp(a.updatedAt).getTime(),
  );
});

// ── Time grouping ────────────────────────────────────────────────────────────

const GROUP_ORDER = ["Today", "Yesterday", "Earlier this week", "Earlier this month", "Older"];

function getTimeGroup(date: Date | string | number): string {
  const d = normalizeTimestamp(date);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);
  const monthStart = new Date(todayStart);
  monthStart.setDate(monthStart.getDate() - 30);

  if (d >= todayStart) return "Today";
  if (d >= yesterdayStart) return "Yesterday";
  if (d >= weekStart) return "Earlier this week";
  if (d >= monthStart) return "Earlier this month";
  return "Older";
}

const groups = computed(() => {
  const map = new Map<string, DocumentWithProperties[]>();
  for (const doc of filtered.value) {
    const g = getTimeGroup(doc.updatedAt);
    if (!map.has(g)) map.set(g, []);
    map.get(g)!.push(doc);
  }
  return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({
    label: g,
    docs: map.get(g)!,
  }));
});

// ── Selection ────────────────────────────────────────────────────────────────

const selectedIds = ref(new Set<string>());
const allIds = computed(() => filtered.value.map((d) => d.id));
const allSelected = computed(
  () => allIds.value.length > 0 && allIds.value.every((id) => selectedIds.value.has(id)),
);

function toggleSelectAll() {
  selectedIds.value = allSelected.value ? new Set() : new Set(allIds.value);
}

const lastClickedId = ref<string | null>(null);

function toggleSelect(id: string, event: MouseEvent) {
  const next = new Set(selectedIds.value);

  if (event.shiftKey && lastClickedId.value && lastClickedId.value !== id) {
    const ids = allIds.value;
    const from = ids.indexOf(lastClickedId.value);
    const to = ids.indexOf(id);
    if (from !== -1 && to !== -1) {
      const [start, end] = from < to ? [from, to] : [to, from];
      for (let i = start; i <= end; i++) next.add(ids[i]);
      selectedIds.value = next;
      return;
    }
  }

  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
  lastClickedId.value = id;
}

function deselectAll() {
  selectedIds.value = new Set();
}

// ── Collapsed groups ─────────────────────────────────────────────────────────

const collapsed = ref(new Set<string>());
function toggleCollapse(label: string) {
  const next = new Set(collapsed.value);
  if (next.has(label)) next.delete(label);
  else next.add(label);
  collapsed.value = next;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function docTitle(doc: DocumentWithProperties) {
  return doc.properties?.title || doc.properties?.name || "Untitled";
}

function docCategoryName(doc: DocumentWithProperties): string | null {
  const slug = doc.properties?.category;
  if (!slug) return null;
  return categoryBySlug.value.get(slug)?.name ?? slug;
}
</script>

<template>
  <div>
    <!-- Toolbar -->
    <div v-if="showToolbar !== false" class="flex items-center gap-2 mb-4">
      <!-- Date range picker -->
      <a-popover-trigger>
        <button
          slot="trigger"
          type="button"
          class="flex items-center gap-1.5 px-2.5 py-1.5 text-size-small border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-primary-300 transition-colors"
          :class="dateRangeLabel ? 'border-primary-300 text-primary-700' : 'border-neutral-200 text-neutral-700'"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="calendarIcon" />
          <span>{{ dateRangeLabel ?? 'Date range' }}</span>
          <button
            v-if="dateRangeLabel"
            type="button"
            @click.stop="clearDateRange"
            class="ml-0.5 text-primary-400 hover:text-primary-700"
          >
            <div class="svg-icon w-3 h-3" v-html="closeXIcon" />
          </button>
        </button>
        <a-popover placements="bottom-start">
          <div class="bg-background border border-neutral-100 rounded-lg shadow-lg p-3 mt-1">
            <a-calendar
              mode="range"
              week-start="1"
              :value="dateRangeStart && dateRangeEnd
                ? `${dateRangeStart.toISOString().slice(0,10)}/${dateRangeEnd.toISOString().slice(0,10)}`
                : undefined"
              @change="onCalendarChange"
              style="
                --calendar-selected-bg: var(--color-primary-500);
                --calendar-selected-color: white;
                --calendar-range-bg: var(--color-primary-100);
                --calendar-hover-bg: var(--color-neutral-100);
              "
            />
          </div>
        </a-popover>
      </a-popover-trigger>

      <div class="flex-1" />

      <!-- Deselect + batch actions (inside toolbar) -->
      <template v-if="selectedIds.size > 0">
        <span class="text-size-small text-neutral-500">{{ selectedIds.size }} selected</span>
        <button
          @click="deselectAll"
          class="p-1 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 rounded transition-colors"
          title="Deselect all"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="closeXIcon" />
        </button>
        <slot name="batch-actions" :selected-ids="selectedIds" :deselect-all="deselectAll" />
      </template>
    </div>

    <!-- Deselect + batch actions (outside toolbar, when toolbar hidden) -->
    <div v-if="showToolbar === false" class="flex items-center justify-end gap-2 mb-4 min-h-[32px]">
      <template v-if="selectedIds.size > 0">
        <span class="text-size-small text-neutral-500">{{ selectedIds.size }} selected</span>
        <button
          @click="deselectAll"
          class="p-1 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 rounded transition-colors"
          title="Deselect all"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="closeXIcon" />
        </button>
        <slot name="batch-actions" :selected-ids="selectedIds" :deselect-all="deselectAll" />
      </template>
    </div>

    <!-- Empty state -->
    <div v-if="filtered.length === 0" class="py-12 text-center text-size-small text-neutral-400">
      {{ items.length === 0 ? (emptyText ?? 'No documents') : 'No documents in the selected date range' }}
    </div>

    <!-- Groups -->
    <div v-else class="space-y-4">
      <div v-for="group in groups" :key="group.label">
        <!-- Group header -->
        <button
          class="flex items-center gap-2 w-full text-left mb-2"
          @click="toggleCollapse(group.label)"
        >
          <div class="svg-icon w-3.5 h-3.5 text-neutral-400" v-html="clockIcon" />
          <span class="text-size-small font-semibold text-neutral-700">{{ group.label }}</span>
          <span class="px-1.5 py-0.5 rounded-full bg-neutral-100 text-neutral-500 text-[11px] font-medium tabular-nums">
            {{ group.docs.length }}
          </span>
          <div class="flex-1" />
          <div
            class="svg-icon w-4 h-4 text-neutral-400 transition-transform"
            :class="collapsed.has(group.label) ? '-rotate-90' : ''"
            v-html="chevronDownIcon"
          />
        </button>

        <!-- Group rows -->
        <div v-if="!collapsed.has(group.label)" class="border border-neutral-100 rounded-lg overflow-hidden">
          <page-target
            v-for="(doc, idx) in group.docs"
            :key="doc.id"
            :data-document-id="doc.id"
            class="relative flex items-center group/row hover:bg-neutral-50 [&[data-dragging]]:opacity-50"
            :class="[
              idx !== 0 ? 'border-t border-neutral-100' : '',
              selectedIds.has(doc.id) ? 'bg-primary-50 hover:bg-primary-50' : '',
            ]"
          >
            <!-- Checkbox -->
            <div class="flex items-center pl-3 shrink-0 self-stretch" @click.stop>
              <input
                type="checkbox"
                :checked="selectedIds.has(doc.id)"
                @click="toggleSelect(doc.id, $event)"
                class="w-3.5 h-3.5 accent-primary-500 cursor-pointer opacity-0 group-hover/row:opacity-100 transition-opacity"
                :class="selectedIds.has(doc.id) ? '!opacity-100' : ''"
              />
            </div>

            <!-- Link: doc icon + title + meta + badge + date -->
            <a
              :href="doc.fileUrl ?? spacePath(currentSpace?.slug, `/doc/${doc.slug}`)"
              :target="doc.fileUrl ? '_blank' : undefined"
              :rel="doc.fileUrl ? 'noopener noreferrer' : undefined"
              class="flex flex-1 items-center gap-3 px-3 py-2.5 min-w-0"
            >
              <div class="svg-icon w-4 h-4 shrink-0 text-neutral-300" v-html="documentIcon" />

              <div class="flex-1 min-w-0">
                <p class="text-size-medium font-medium text-neutral-800 truncate">{{ docTitle(doc) }}</p>
                <p class="text-[11px] text-neutral-400 truncate">
                  <span v-if="docCategoryName(doc)">{{ docCategoryName(doc) }} • </span>
                  <span class="capitalize">{{ doc.type || "Document" }}</span>
                </p>
              </div>

              <span
                v-if="doc.properties?.category"
                class="shrink-0 px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-600 text-[11px] font-medium"
              >
                {{ doc.properties.category }}
              </span>

              <span class="shrink-0 text-[11px] text-neutral-400 tabular-nums w-20 text-right">
                {{ formatDate(doc.updatedAt) }}
              </span>
            </a>

            <!-- Row actions slot -->
            <div
              class="flex items-center gap-1 pr-3 shrink-0 opacity-0 group-hover/row:opacity-100 transition-opacity"
              @click.stop
            >
              <slot name="row-actions" :doc="doc" />
            </div>
          </page-target>
        </div>
      </div>
    </div>
  </div>
</template>
