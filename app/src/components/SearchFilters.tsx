import { createMemo, createSignal, For, Show } from "solid-js";
import { api, type PropertyFilter } from "#api/client.ts";
import { addIcon, cancelIcon, chevronRightThinIcon, dateIcon } from "#assets/icons.ts";
import { useQuery } from "#composeables/query.ts";
import "@atrium-ui/elements/calendar";
import "@atrium-ui/elements/popover";

interface Props {
  spaceId: string;
  /** Two-way bound value. */
  value: PropertyFilter[];
  onInput?: (filters: PropertyFilter[]) => void;
  onSearch?: () => void;
}

const DATE_FILTER_KEY = "_date";

const TYPE_STYLES: Record<string, string> = {
  canvas: "bg-violet-100 text-violet-600",
  csv: "bg-emerald-100 text-emerald-700",
  file: "bg-neutral-100 text-neutral-600",
  document: "bg-neutral-100 text-neutral-600",
};

const chipBase =
  "flex items-center gap-1 py-1 px-3xs text-interactive rounded-lg border transition-colors text-size-small";
const chipInactive =
  "bg-background border-neutral-200 text-neutral-600 hover:border-neutral-300 hover:bg-primary-10";
const chipActive =
  "bg-primary-50 border-primary-200 text-primary-700 hover:bg-primary-100";

const popoverPanel =
  "w-max opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100";
const popoverInner =
  "bg-background border border-neutral-100 rounded-lg origin-top-left scale-95 transition-all shadow-large duration-150 group-[[enabled]]:scale-100 overflow-hidden";

export function SearchFilters(props: Props) {
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
    queryFn: async () => {
      const properties = await api.properties.get(props.spaceId);
      return properties.filter((p) => p.name !== "title" && !p.name.startsWith("_"));
    },
  });

  const typeValues = createMemo(
    () => availableProperties()?.find((p) => p.name === "type")?.values ?? [],
  );

  const nonTypeProperties = createMemo(
    () => availableProperties()?.filter((p) => p.name !== "type") ?? [],
  );

  const activePropertyFilters = createMemo(() =>
    props.value.filter((f) => f.key !== DATE_FILTER_KEY && f.key !== "type"),
  );

  const hasActiveFilter = (key: string, value: string | null) =>
    props.value.some((f) => f.key === key && f.value === value);

  const removeFilterByKeyValue = (key: string, value: string | null) => {
    commit(props.value.filter((f) => !(f.key === key && f.value === value)));
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
      {/* Date range picker */}
      <a-popover-trigger class="group">
        <button
          type="button"
          slot="trigger"
          class={`${chipBase} ${activeDateRange() ? chipActive : chipInactive}`}
        >
          <div class="svg-icon h-3 w-3 opacity-60" innerHTML={dateIcon} />
          <span>{dateRangeLabel() ?? "Modified"}</span>
          <Show when={activeDateRange()}>
            {/* biome-ignore lint/a11y/useFocusableInteractive: a nested control inside the chip trigger; the trigger itself takes the focus. */}
            {/* biome-ignore lint/a11y/useSemanticElements: a <button> here would nest inside the trigger <button>, which is invalid HTML. */}
            <span
              role="button"
              class="flex-none hover:opacity-70"
              onClick={clearDateFilter}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.stopPropagation();
                commit(props.value.filter((f) => f.key !== DATE_FILTER_KEY));
              }}
            >
              <div class="svg-icon h-3 w-3" innerHTML={cancelIcon} />
            </span>
          </Show>
        </button>

        <a-popover class="group" placements="bottom-start">
          <div class={popoverPanel}>
            <div class={`${popoverInner} p-3`}>
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

      {/* Type filter chips */}
      <For each={typeValues()}>
        {(tv) => (
          <button
            type="button"
            onClick={() => toggleFilter("type", tv)}
            class={`${chipBase} capitalize ${
              hasActiveFilter("type", tv)
                ? `${TYPE_STYLES[tv] ?? "bg-neutral-100 text-neutral-600"} border-transparent`
                : chipInactive
            }`}
          >
            {tv}
            <Show when={hasActiveFilter("type", tv)}>
              {/* biome-ignore lint/a11y/useFocusableInteractive: a nested control inside the chip; the chip itself takes the focus. */}
              {/* biome-ignore lint/a11y/useSemanticElements: a <button> here would nest inside the chip <button>, which is invalid HTML. */}
              <span
                role="button"
                class="flex-none hover:opacity-70"
                onClick={(event) => {
                  event.stopPropagation();
                  removeFilterByKeyValue("type", tv);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.stopPropagation();
                  removeFilterByKeyValue("type", tv);
                }}
              >
                <div class="svg-icon h-3 w-3" innerHTML={cancelIcon} />
              </span>
            </Show>
          </button>
        )}
      </For>

      {/* Active property filter chips */}
      <For each={activePropertyFilters()}>
        {(filter) => (
          <div class={`${chipBase} ${chipActive}`}>
            <span class="font-medium">{filter.key}</span>
            <span class="opacity-40">:</span>
            <span classList={{ "italic opacity-70": filter.value === null }}>
              {filter.value ?? "exists"}
            </span>
            <button
              type="button"
              onClick={() => removeFilterByKeyValue(filter.key, filter.value)}
              class="ml-0.5 flex-none hover:opacity-70"
            >
              <div class="svg-icon h-3 w-3" innerHTML={cancelIcon} />
            </button>
          </div>
        )}
      </For>

      {/* Add property filter */}
      <Show when={nonTypeProperties().length > 0}>
        <a-popover-trigger class="group">
          <button
            type="button"
            slot="trigger"
            class="flex items-center gap-1 rounded-lg border border-neutral-300 border-dashed px-3xs py-1 text-interactive text-neutral-500 text-size-small transition-colors hover:border-primary-300 hover:text-primary-600"
          >
            <div class="svg-icon h-3.5 w-3.5" innerHTML={addIcon} />
            <span>Filter</span>
          </button>

          <a-popover class="group" placements="bottom-start">
            <div class={popoverPanel}>
              <div class={`${popoverInner} w-52`}>
                <div class="border-neutral-100 border-b px-3 py-2">
                  <span class="font-medium text-neutral text-size-extra-small uppercase tracking-wider">
                    Properties
                  </span>
                </div>
                <div class="max-h-64 overflow-y-auto py-1">
                  <For each={nonTypeProperties()}>
                    {(prop) => (
                      <div class="px-1">
                        <button
                          type="button"
                          onClick={() => toggleProperty(prop.name)}
                          class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-neutral-700 text-size-small transition-colors hover:bg-primary-50 hover:transition-none"
                        >
                          <div
                            class="svg-icon h-3 w-3 flex-none text-neutral transition-transform duration-150"
                            classList={{
                              "rotate-90": expandedProperties().has(prop.name),
                            }}
                            innerHTML={chevronRightThinIcon}
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
                              any value
                            </button>
                            <Show when={prop.values.length > 20}>
                              <span class="px-2 text-neutral-400 text-size-extra-small">
                                +{prop.values.length - 20} more
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

      {/* Clear all */}
      <Show when={props.value.length > 0}>
        <button
          type="button"
          onClick={() => commit([])}
          class="ml-1 text-neutral text-size-extra-small transition-colors hover:text-neutral-800"
        >
          Clear all
        </button>
      </Show>
    </div>
  );
}
