import { createMemo, createSignal, For, Show } from "solid-js";
import { twMerge } from "tailwind-merge";
import { api, type PropertyFilter } from "#api/client.ts";
import { useQuery } from "#composeables/query.ts";
import {
  canonicalPropertyKey,
  DATE_FILTER_KEY,
  DOCUMENT_TYPE_FILTER_KEY,
} from "#documents/properties.ts";
import "@atrium-ui/elements/calendar";
import "@atrium-ui/elements/popover";
import { Icon, type IconName } from "./Icon.tsx";
import { useTranslation } from "#composeables/useTranslation.ts";

interface Props {
  spaceId: string;
  value: PropertyFilter[];
  onInput?: (filters: PropertyFilter[]) => void;
  onSearch?: () => void;
}

/* Every chip in the row — date, type, property, add — shares one shell so the
 * row reads as a single control instead of a pile of one-off buttons. These are
 * concatenated, never run through twMerge: it reads the project's `text-size-*`
 * and `text-interactive` as plain `text-*` and drops all but the last one. */
const CHIP =
  "inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-lg border px-3xs font-medium text-size-small transition-colors focus-visible:outline-2 focus-visible:outline-primary-500 focus-visible:outline-offset-1";
const CHIP_IDLE =
  "cursor-pointer border-neutral-200 bg-background text-neutral-600 hover:border-neutral-300 hover:bg-primary-10";
const CHIP_ACTIVE = "border-primary-200 bg-primary-50 text-primary-700";
const CHIP_REMOVE =
  "-mr-1 flex-none rounded-full p-0.5 opacity-60 transition-opacity hover:opacity-100";

/* Types come from the documents in the space, so an extension can introduce one
 * this map has never heard of — hence the generic fallback. */
const TYPE_ICONS: Record<string, IconName> = {
  app: "extension",
  canvas: "canvas",
  database: "database",
  document: "document",
  file: "file",
  markdown: "source-code",
  record: "record",
  workflow: "bolt",
};

export function SearchFilters(props: Props) {
  const t = useTranslation();

  const activeDateFilter = createMemo(
    () => props.value.find((f) => f.key === DATE_FILTER_KEY)?.value ?? null,
  );

  const activeDateRange = createMemo(() => {
    const v = activeDateFilter();
    if (!v?.includes("/")) return null;
    const [start, end] = v.split("/");
    return { start: new Date(start), end: new Date(end) };
  });

  const dateRangeLabel = createMemo(() => {
    const range = activeDateRange();
    if (!range) return null;
    const fmt = (d: Date) =>
      d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    return `${fmt(range.start)} – ${fmt(range.end)}`;
  });

  function commit(filters: PropertyFilter[]) {
    props.onInput?.(filters);
    props.onSearch?.();
  }

  function onCalendarChange(e: Event) {
    const value = (e.target as HTMLElement & { value?: string }).value ?? "";
    const withoutDate = props.value.filter((f) => f.key !== DATE_FILTER_KEY);
    commit(value ? [...withoutDate, { key: DATE_FILTER_KEY, value }] : withoutDate);
  }

  function clearDateFilter(e: MouseEvent) {
    e.stopPropagation();
    commit(props.value.filter((f) => f.key !== DATE_FILTER_KEY));
  }

  const [expandedProperties, setExpandedProperties] = createSignal(new Set<string>());

  const { data: availableProperties } = useQuery({
    queryKey: createMemo(() => ["properties", props.spaceId]),
    queryFn: () => api.properties.get(props.spaceId),
  });

  const typeValues = createMemo(
    () =>
      availableProperties()?.find((p) => p.name === DOCUMENT_TYPE_FILTER_KEY)?.values ??
      [],
  );

  const filterableProperties = createMemo(
    () =>
      availableProperties()?.filter(
        (p) => canonicalPropertyKey(p.name) !== "title" && !p.name.startsWith("_"),
      ) ?? [],
  );

  const activePropertyFilters = createMemo(() =>
    props.value.filter(
      (f) => f.key !== DATE_FILTER_KEY && f.key !== DOCUMENT_TYPE_FILTER_KEY,
    ),
  );

  // A chip carries the spelling the space listing prevails on, not always the one
  // an active filter was created with.
  const isFilterFor = (filter: PropertyFilter, key: string, value: string | null) =>
    canonicalPropertyKey(filter.key) === canonicalPropertyKey(key) &&
    filter.value === value;

  const hasActiveFilter = (key: string, value: string | null) =>
    props.value.some((f) => isFilterFor(f, key, value));

  const removeFilterByKeyValue = (key: string, value: string | null) => {
    commit(props.value.filter((f) => !isFilterFor(f, key, value)));
  };

  const toggleFilter = (key: string, value: string | null) => {
    if (hasActiveFilter(key, value)) {
      removeFilterByKeyValue(key, value);
      return;
    }
    commit([...props.value, { key, value }]);
  };

  const toggleProperty = (name: string) => {
    const next = new Set(expandedProperties());
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setExpandedProperties(next);
  };

  return (
    <div class="flex select-none flex-wrap items-center gap-2">
      <a-popover-trigger class="group flex-none">
        <button
          type="button"
          slot="trigger"
          class={`${CHIP} cursor-pointer ${
            activeDateRange() ? `${CHIP_ACTIVE} hover:bg-primary-100` : CHIP_IDLE
          }`}
        >
          <Icon class="h-3.5 w-3.5 flex-none opacity-60" name="date" />
          <span>{dateRangeLabel() ?? t("Modified")}</span>
          <Show
            when={activeDateRange()}
            fallback={
              <Icon class="-mr-1 h-3 w-3 flex-none opacity-40" name="chevron-down" />
            }
          >
            {/* biome-ignore lint/a11y/useFocusableInteractive: a nested control inside the chip trigger; the trigger itself takes the focus. */}
            {/* biome-ignore lint/a11y/useSemanticElements: a <button> here would nest inside the trigger <button>, which is invalid HTML. */}
            <span
              role="button"
              aria-label={t("Remove filter")}
              class={CHIP_REMOVE}
              onClick={clearDateFilter}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.stopPropagation();
                commit(props.value.filter((f) => f.key !== DATE_FILTER_KEY));
              }}
            >
              <Icon class="h-3 w-3" name="cancel" />
            </span>
          </Show>
        </button>

        <a-popover class="group" placements="bottom-start">
          <div class="w-max opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100">
            <div class="origin-top-left scale-95 overflow-hidden rounded-lg border border-neutral-100 bg-background p-3 shadow-large transition-all duration-150 group-[[enabled]]:scale-100">
              <a-calendar
                mode="range"
                week-start="1"
                attr:value={activeDateFilter() ?? undefined}
                on:change={onCalendarChange}
                style={{
                  "--calendar-selected-bg": "var(--color-primary-500)",
                  "--calendar-selected-color": "white",
                  "--calendar-range-bg": "var(--color-primary-100)",
                  "--calendar-hover-bg": "var(--color-neutral-100)",
                }}
              />
            </div>
          </div>
        </a-popover>
      </a-popover-trigger>

      <For each={typeValues()}>
        {(tv) => (
          <button
            type="button"
            aria-pressed={hasActiveFilter(DOCUMENT_TYPE_FILTER_KEY, tv)}
            onClick={() => toggleFilter(DOCUMENT_TYPE_FILTER_KEY, tv)}
            class={`${CHIP} cursor-pointer capitalize ${
              hasActiveFilter(DOCUMENT_TYPE_FILTER_KEY, tv)
                ? `${CHIP_ACTIVE} hover:bg-primary-100`
                : CHIP_IDLE
            }`}
          >
            <Icon
              class="h-3.5 w-3.5 flex-none opacity-60"
              name={TYPE_ICONS[tv] ?? "document"}
            />
            {tv}
          </button>
        )}
      </For>

      <For each={activePropertyFilters()}>
        {(filter) => (
          <div class={`${CHIP} ${CHIP_ACTIVE}`}>
            <span class="opacity-70">{filter.key}:</span>
            <span classList={{ "italic opacity-70": filter.value === null }}>
              {filter.value ?? t("any value")}
            </span>
            <button
              type="button"
              aria-label={t("Remove filter")}
              onClick={() => removeFilterByKeyValue(filter.key, filter.value)}
              class={`${CHIP_REMOVE} cursor-pointer`}
            >
              <Icon class="h-3 w-3" name="cancel" />
            </button>
          </div>
        )}
      </For>

      <Show when={filterableProperties().length > 0}>
        <a-popover-trigger class="group flex-none">
          <button
            type="button"
            slot="trigger"
            class={`${CHIP} cursor-pointer border-neutral-300 border-dashed bg-background text-neutral-500 hover:border-primary-300 hover:bg-primary-10 hover:text-primary-600`}
          >
            <Icon class="h-3.5 w-3.5 flex-none" name="add" />
            <span>{t("Filter")}</span>
          </button>

          <a-popover class="group" placements="bottom-start">
            <div class="w-max opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100">
              <div class="w-52 origin-top-left scale-95 overflow-hidden rounded-lg border border-neutral-100 bg-background shadow-large transition-all duration-150 group-[[enabled]]:scale-100">
                <div class="border-neutral-100 border-b px-3 py-2">
                  <span class="font-medium text-neutral-500 text-size-extra-small uppercase tracking-wider">
                    {t("Properties")}
                  </span>
                </div>
                <div class="max-h-64 overflow-y-auto py-1">
                  <For each={filterableProperties()}>
                    {(prop) => (
                      <div class="px-1">
                        <button
                          type="button"
                          onClick={() => toggleProperty(prop.name)}
                          class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-neutral-700 text-size-small transition-colors hover:bg-primary-50 hover:transition-none"
                        >
                          <Icon
                            class={twMerge(
                              "h-3 w-3 flex-none text-neutral-400 transition-transform duration-150",
                              expandedProperties().has(prop.name) && "rotate-90",
                            )}
                            name="chevron-right-thin"
                          />
                          <span class="flex-1 truncate">{prop.name}</span>
                          <Show
                            when={
                              props.value.filter((f) => f.key === prop.name).length > 0
                            }
                          >
                            <span class="rounded-full bg-primary-100 px-1.5 py-0.5 text-primary-700 text-size-extra-small">
                              {props.value.filter((f) => f.key === prop.name).length}
                            </span>
                          </Show>
                        </button>

                        <Show when={expandedProperties().has(prop.name)}>
                          <div class="mt-0.5 mb-1 ml-5 flex flex-col gap-0.5">
                            <For each={prop.values.slice(0, 20)}>
                              {(val) => (
                                <button
                                  type="button"
                                  onClick={() => toggleFilter(prop.name, val)}
                                  class="rounded-sm px-2 py-1 text-left text-size-small transition-colors hover:transition-none"
                                  classList={{
                                    "bg-primary-100 font-medium text-primary-700":
                                      hasActiveFilter(prop.name, val),
                                    "text-neutral-600 hover:bg-primary-50":
                                      !hasActiveFilter(prop.name, val),
                                  }}
                                >
                                  {val}
                                </button>
                              )}
                            </For>
                            <button
                              type="button"
                              onClick={() => toggleFilter(prop.name, null)}
                              class="rounded-sm px-2 py-1 text-left text-size-small italic transition-colors hover:transition-none"
                              classList={{
                                "bg-primary-100 font-medium text-primary-700":
                                  hasActiveFilter(prop.name, null),
                                "text-neutral-500 hover:bg-primary-50": !hasActiveFilter(
                                  prop.name,
                                  null,
                                ),
                              }}
                            >
                              {t("any value")}
                            </button>
                            <Show when={prop.values.length > 20}>
                              <span class="px-2 text-neutral-400 text-size-extra-small">
                                {t("+{count} more").replace(
                                  "{count}",
                                  String(prop.values.length - 20),
                                )}
                              </span>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </a-popover>
        </a-popover-trigger>
      </Show>

      <Show when={props.value.length > 0}>
        <span aria-hidden="true" class="mx-1 h-4 w-px flex-none bg-neutral-100" />
        <button
          type="button"
          onClick={() => commit([])}
          class="inline-flex h-8 cursor-pointer items-center rounded-lg px-4xs font-medium text-neutral-500 text-size-small transition-colors hover:bg-neutral-50 hover:text-neutral-800 focus-visible:outline-2 focus-visible:outline-primary-500 focus-visible:outline-offset-1"
        >
          {t("Clear all")}
        </button>
      </Show>
    </div>
  );
}
