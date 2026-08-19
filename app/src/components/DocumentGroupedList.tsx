import "@atrium-ui/elements/calendar";
import "@atrium-ui/elements/popover";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onMount,
  Show,
} from "solid-js";
import { twMerge } from "tailwind-merge";
import type { Category, DocumentWithProperties } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { propertyValueToScalar, propertyValueToText } from "#documents/properties.ts";
import { formatDate, normalizeTimestamp } from "#utils/datetime.ts";
import { currentLang, t } from "#utils/lang.ts";
import { spacePath } from "#utils/utils.ts";
import { Icon } from "./Icon.tsx";
import { SearchSnippet } from "./SearchSnippet.tsx";

type DocumentListItem = DocumentWithProperties & {
  snippet?: string;
};

interface Props {
  items: DocumentListItem[];
  categories?: Category[];
  emptyText?: string;
  showToolbar?: boolean;
  preserveOrder?: boolean;
  batchActions?: (selectedIds: Set<string>, deselectAll: () => void) => JSX.Element;
  rowActions?: (doc: DocumentWithProperties) => JSX.Element;
}

const GROUP_ORDER = [
  "today",
  "yesterday",
  "earlier-this-week",
  "earlier-this-month",
  "older",
] as const;

type TimeGroup = (typeof GROUP_ORDER)[number];

function getTimeGroup(date: Date | string | number): TimeGroup {
  const d = normalizeTimestamp(date);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);
  const monthStart = new Date(todayStart);
  monthStart.setDate(monthStart.getDate() - 30);

  if (d >= todayStart) return "today";
  if (d >= yesterdayStart) return "yesterday";
  if (d >= weekStart) return "earlier-this-week";
  if (d >= monthStart) return "earlier-this-month";
  return "older";
}

export function DocumentGroupedList(props: Props) {
  const { currentSpace } = useSpace();

  onMount(() => {
    import("#editor/elements/page-target.ts");
  });

  const categoryBySlug = createMemo(() => {
    const map = new Map<string, Category>();
    for (const c of props.categories ?? []) map.set(c.slug, c);
    return map;
  });

  const [dateRangeStart, setDateRangeStart] = createSignal<Date | null>(null);
  const [dateRangeEnd, setDateRangeEnd] = createSignal<Date | null>(null);

  const dateRangeLabel = createMemo(() => {
    const start = dateRangeStart();
    const end = dateRangeEnd();
    if (!start && !end) return null;
    const fmt = (d: Date) =>
      d.toLocaleDateString(currentLang(), {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    if (start && end) return `${fmt(start)} – ${fmt(end)}`;
    const single = start ?? end;
    return single ? fmt(single) : null;
  });

  function onCalendarChange(e: Event) {
    const value = (e.target as HTMLElement & { value?: string }).value ?? "";
    if (!value) {
      setDateRangeStart(null);
      setDateRangeEnd(null);
      return;
    }
    const [start, end] = value.split("/");
    setDateRangeStart(start ? new Date(start) : null);
    setDateRangeEnd(end ? new Date(end) : null);
  }

  function clearDateRange() {
    setDateRangeStart(null);
    setDateRangeEnd(null);
  }

  const filtered = createMemo(() => {
    let docs = props.items; // solid-reactivity-ok: memo body, re-reads per recompute
    const rangeStart = dateRangeStart();
    const rangeEnd = dateRangeEnd();
    if (rangeStart) {
      const start = rangeStart.getTime();
      docs = docs.filter((d) => normalizeTimestamp(d.updatedAt).getTime() >= start);
    }
    if (rangeEnd) {
      const end = new Date(rangeEnd);
      end.setDate(end.getDate() + 1);
      docs = docs.filter(
        (d) => normalizeTimestamp(d.updatedAt).getTime() < end.getTime(),
      );
    }
    if (props.preserveOrder) return [...docs];

    return [...docs].sort(
      (a, b) =>
        normalizeTimestamp(b.updatedAt).getTime() -
        normalizeTimestamp(a.updatedAt).getTime(),
    );
  });

  const groups = createMemo(() => {
    const map = new Map<TimeGroup, DocumentListItem[]>();
    for (const doc of filtered()) {
      const g = getTimeGroup(doc.updatedAt);
      if (!map.has(g)) map.set(g, []);
      map.get(g)?.push(doc);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({
      id: g,
      label: {
        today: t("Today"),
        yesterday: t("Yesterday"),
        "earlier-this-week": t("Earlier this week"),
        "earlier-this-month": t("Earlier this month"),
        older: t("Older"),
      }[g],
      docs: map.get(g) ?? [],
    }));
  });

  const [selectedIds, setSelectedIds] = createSignal(new Set<string>());
  const allIds = createMemo(() => filtered().map((d) => d.id));
  let lastClickedId: string | null = null;

  function toggleSelect(id: string, event: MouseEvent) {
    const next = new Set(selectedIds());

    if (event.shiftKey && lastClickedId && lastClickedId !== id) {
      const ids = allIds();
      const from = ids.indexOf(lastClickedId);
      const to = ids.indexOf(id);
      if (from !== -1 && to !== -1) {
        const [start, end] = from < to ? [from, to] : [to, from];
        for (let i = start; i <= end; i++) next.add(ids[i]);
        setSelectedIds(next);
        return;
      }
    }

    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
    lastClickedId = id;
  }

  function deselectAll() {
    setSelectedIds(new Set<string>());
  }

  createEffect(
    on(
      () => props.items,
      () => {
        const availableIds = new Set(allIds());
        const next = new Set<string>(
          [...selectedIds()].filter((id) => availableIds.has(id)),
        );
        if (next.size !== selectedIds().size) setSelectedIds(next);
      },
      { defer: true },
    ),
  );

  const [collapsed, setCollapsed] = createSignal(new Set<TimeGroup>());
  function toggleCollapse(groupId: TimeGroup) {
    const next = new Set(collapsed());
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    setCollapsed(next);
  }

  function docTitle(doc: DocumentListItem) {
    const title = doc.properties?.title ?? doc.properties?.name;
    return title ? propertyValueToText(title) : t("Untitled");
  }

  function docCategoryName(doc: DocumentListItem): string | null {
    const category = doc.properties?.category;
    const slug = propertyValueToScalar(category) ?? "";
    if (!slug) return null;
    return categoryBySlug().get(slug)?.name ?? slug;
  }

  const selectionBar = () => (
    <Show when={selectedIds().size > 0}>
      <span class="text-neutral-500 text-size-small">
        {selectedIds().size} {t("selected")}
      </span>
      <button
        type="button"
        onClick={deselectAll}
        class="rounded p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
        title={t("Deselect all")}
      >
        <Icon class="h-3.5 w-3.5" name="cancel" />
      </button>
      {props.batchActions?.(selectedIds(), deselectAll)}
    </Show>
  );

  return (
    <div>
      <Show when={props.showToolbar !== false}>
        <div class="mb-4 flex items-center gap-2">
          <a-popover-trigger>
            <button
              slot="trigger"
              type="button"
              class="flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-size-small transition-colors focus:outline-none focus:ring-1 focus:ring-primary-300"
              classList={{
                "border-primary-300 text-primary-700": !!dateRangeLabel(),
                "border-neutral-200 text-neutral-700": !dateRangeLabel(),
              }}
            >
              <Icon class="h-3.5 w-3.5" name="date" />
              <span>{dateRangeLabel() ?? t("Date range")}</span>
              <Show when={dateRangeLabel()}>
                {/* biome-ignore lint/a11y/useFocusableInteractive: a nested control inside the popover trigger; the trigger itself takes the focus. */}
                {/* biome-ignore lint/a11y/useSemanticElements: a <button> here would nest inside the trigger <button>, which is invalid HTML. */}
                <span
                  role="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    clearDateRange();
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.stopPropagation();
                    clearDateRange();
                  }}
                  class="ml-0.5 text-primary-400 hover:text-primary-700"
                >
                  <Icon class="h-3 w-3" name="cancel" />
                </span>
              </Show>
            </button>
            <a-popover placements="bottom-start">
              <div class="mt-1 rounded-lg border border-neutral-100 bg-background p-3 shadow-lg">
                <a-calendar
                  mode="range"
                  week-start="1"
                  attr:value={
                    dateRangeStart() && dateRangeEnd()
                      ? `${dateRangeStart()?.toISOString().slice(0, 10)}/${dateRangeEnd()?.toISOString().slice(0, 10)}`
                      : undefined
                  }
                  on:change={onCalendarChange}
                  style={{
                    "--calendar-selected-bg": "var(--color-primary-500)",
                    "--calendar-selected-color": "white",
                    "--calendar-range-bg": "var(--color-primary-100)",
                    "--calendar-hover-bg": "var(--color-neutral-100)",
                  }}
                />
              </div>
            </a-popover>
          </a-popover-trigger>

          <div class="flex-1" />

          {selectionBar()}
        </div>
      </Show>

      <Show when={props.showToolbar === false}>
        <div class="mb-4 flex min-h-[32px] items-center justify-end gap-2">
          {selectionBar()}
        </div>
      </Show>

      <Show
        when={filtered().length > 0}
        fallback={
          <div class="py-12 text-center text-neutral-400 text-size-small">
            {props.items.length === 0
              ? (props.emptyText ?? t("No documents"))
              : t("No documents in the selected date range")}
          </div>
        }
      >
        <div class="space-y-4">
          <For each={groups()}>
            {(group) => (
              <div>
                <button
                  type="button"
                  class="mb-2 flex w-full items-center gap-2 text-left"
                  onClick={() => toggleCollapse(group.id)}
                >
                  <Icon class="h-3.5 w-3.5 text-neutral-400" name="activity" />
                  <span class="font-semibold text-neutral-700 text-size-small">
                    {group.label}
                  </span>
                  <span class="rounded-full bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-500 text-size-extra-small tabular-nums">
                    {group.docs.length}
                  </span>
                  <div class="flex-1" />
                  <Icon
                    class={twMerge(
                      "h-4 w-4 text-neutral-400 transition-transform",
                      collapsed().has(group.id) && "-rotate-90",
                    )}
                    name="chevron-down"
                  />
                </button>

                <a-expandable
                  attr:opened={collapsed().has(group.id) ? undefined : ""}
                  inert={collapsed().has(group.id)}
                  class="overflow-hidden rounded-lg border border-neutral-100"
                >
                  <For each={group.docs}>
                    {(doc, idx) => (
                      <page-target
                        attr:data-document-id={doc.id}
                        attr:data-document-type={doc.type ?? undefined}
                        attr:data-space-id={currentSpace()?.id}
                        attr:data-document-url={spacePath(
                          currentSpace()?.slug,
                          `/doc/${doc.slug}`,
                        )}
                        class="group/row relative flex items-center hover:bg-neutral-50 [&[data-dragging]]:opacity-50"
                        classList={{
                          "border-neutral-100 border-t": idx() !== 0,
                          "bg-primary-50 hover:bg-primary-50": selectedIds().has(doc.id),
                        }}
                      >
                        {/* biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only stops the row's click from reaching the link; the checkbox is the control. */}
                        {/* biome-ignore lint/a11y/useKeyWithClickEvents: nothing is activated here, so there is no keyboard equivalent to add. */}
                        <div
                          class="flex shrink-0 items-center self-stretch pl-3"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={selectedIds().has(doc.id)}
                            onClick={(event) => toggleSelect(doc.id, event)}
                            class="h-3.5 w-3.5 cursor-pointer accent-primary-500 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100"
                            classList={{ "!opacity-100": selectedIds().has(doc.id) }}
                          />
                        </div>

                        <a
                          href={
                            doc.fileUrl ??
                            spacePath(currentSpace()?.slug, `/doc/${doc.slug}`)
                          }
                          target={doc.fileUrl ? "_blank" : undefined}
                          rel={doc.fileUrl ? "noopener noreferrer" : undefined}
                          class="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5"
                        >
                          <Icon
                            class="h-4 w-4 shrink-0 text-neutral-300"
                            name="document"
                          />

                          <div class="min-w-0 flex-1">
                            <p class="truncate font-medium text-neutral-800 text-size-medium">
                              {docTitle(doc)}
                            </p>
                            <p class="truncate text-neutral-400 text-size-extra-small">
                              <Show when={docCategoryName(doc)}>
                                <span>{docCategoryName(doc)} • </span>
                              </Show>
                              <span class="capitalize">{doc.type || t("Document")}</span>
                            </p>
                            <Show when={doc.snippet}>
                              {(snippet) => (
                                <SearchSnippet html={snippet()} class="mt-1" />
                              )}
                            </Show>
                          </div>

                          <Show when={docCategoryName(doc)}>
                            <span class="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 font-medium text-neutral-600 text-size-extra-small">
                              {docCategoryName(doc)}
                            </span>
                          </Show>

                          <span class="w-20 shrink-0 text-right text-neutral-400 text-size-extra-small tabular-nums">
                            {formatDate(doc.updatedAt)}
                          </span>
                        </a>

                        {/* biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only stops the row's click from reaching the link; the actions are the controls. */}
                        {/* biome-ignore lint/a11y/useKeyWithClickEvents: nothing is activated here, so there is no keyboard equivalent to add. */}
                        <div
                          class="flex shrink-0 items-center gap-1 pr-3 opacity-0 transition-opacity group-hover/row:opacity-100"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {props.rowActions?.(doc)}
                        </div>
                      </page-target>
                    )}
                  </For>
                </a-expandable>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
