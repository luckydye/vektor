import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { twMerge } from "tailwind-merge";
import type { Property } from "#documents/properties.ts";
import { t } from "#utils/lang.ts";
import { Icon } from "./Icon.tsx";
import { SelectMenu, type SelectMenuItem } from "./SelectMenu.tsx";
import "@atrium-ui/elements/blur";
import "@atrium-ui/elements/calendar";
import { addIcon } from "#assets/icons.ts";

interface Props {
  label?: string;
  nameLabel?: string;
  valueLabels?: string[];
  icon?: string;
  variant?: "default" | "special";
  readonly?: boolean;
  property?: Property | null;
  allowMultiple?: boolean;
  showTooltip?: boolean;
  propertyValues?: (property: Property) => Promise<SelectMenuItem[]>;
  onUpdate?: (property: Property & { search: string }) => void;
  onDelete?: (property: Property) => void;
}

export function PropertyChip(props: Props) {
  let inputElement: HTMLInputElement | undefined;

  const [valueOptions, setValueOptions] = createSignal<SelectMenuItem[]>([]);
  const [isEditPopoverOpen, setIsEditPopoverOpen] = createSignal(false);
  const [propertyName, setPropertyName] = createSignal(props.property?.name || "");
  const [selectedValue, setSelectedValue] = createSignal<string | string[] | undefined>(
    props.property?.value,
  );
  const [searchInput, setSearchInput] = createSignal("");
  const [dateValue, setDateValue] = createSignal("");

  const selectedValues = createMemo(() => {
    const value = selectedValue();
    if (Array.isArray(value)) return value;
    return value ? [value] : [];
  });

  const valueLabels = createMemo(() => props.valueLabels ?? []);

  const handleClick = async () => {
    const property = props.property; // solid-reactivity-ok: handler, re-reads per call
    if (props.readonly || !property) return;

    setIsEditPopoverOpen(!isEditPopoverOpen());
    setPropertyName(property.name);
    setSelectedValue(property.value);

    // For date properties, set the date value
    if (property.type === "date" && property.value && !Array.isArray(property.value)) {
      setDateValue(property.value);
    }

    await new Promise((resolve) => setTimeout(resolve, 25));

    // Only fetch options for non-date properties
    if (property.type !== "date") {
      inputElement?.focus();

      props.propertyValues?.(property).then(setValueOptions);
    }
  };

  const filteredValueOptions = createMemo(() => {
    const searchTerm = searchInput().toLowerCase();
    const items = valueOptions().filter((item) =>
      item.label?.toLowerCase().includes(searchTerm),
    );
    if (items.length === 0) {
      return [
        {
          id: "__new__",
          label: t("Add {value}").replace("{value}", searchInput()),
          icon: addIcon,
        },
      ];
    }
    return items;
  });

  const handleExit = () => {
    setIsEditPopoverOpen(false);
    setSearchInput("");
    setDateValue("");
  };

  const handleValueSelect = (item: SelectMenuItem) => {
    const property = props.property; // solid-reactivity-ok: handler, re-reads per call
    if (!property) return;

    const itemValue = item.id === "__new__" ? searchInput().trim() : item.id;
    if (!itemValue) return;

    if (props.allowMultiple) {
      const nextValue = selectedValues().includes(itemValue)
        ? selectedValues().filter((value) => value !== itemValue)
        : [...selectedValues(), itemValue];

      setSelectedValue(nextValue);
      props.onUpdate?.({
        ...property,
        name: propertyName(),
        value: nextValue,
        search: searchInput(),
      });
      setSearchInput("");
      return;
    }

    setSelectedValue(itemValue);
    props.onUpdate?.({
      ...property,
      name: propertyName(),
      value: itemValue,
      search: searchInput(),
    });
    handleExit();
  };

  const handleDateChange = (event: Event) => {
    const target = event.target as HTMLInputElement;
    const property = props.property; // solid-reactivity-ok: handler, re-reads per call
    if (!property) return;
    props.onUpdate?.({
      ...property,
      name: propertyName(),
      value: target.value,
      search: "",
    });
    handleExit();
  };

  const handleDelete = () => {
    const property = props.property; // solid-reactivity-ok: handler, re-reads per call
    if (!property) return;
    props.onDelete?.(property);
    handleExit();
  };

  onMount(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest("a-blur") && isEditPopoverOpen()) {
        handleExit();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    onCleanup(() => window.removeEventListener("pointerdown", onPointerDown));
  });

  const chipClass = () => ({
    "text-interactive flex items-center gap-4xs py-6xs px-4xs rounded-lg transition-colors": true,
    "bg-primary-50 hover:bg-primary-100 border border-primary-100":
      props.variant === "special",
    "bg-background hover:bg-primary-10 border border-primary-200":
      props.variant === "default",
    "cursor-pointer": !!props.property && !props.readonly,
    "cursor-default": !props.property || !!props.readonly,
  });

  const iconClass = () =>
    props.variant === "special" ? "[&_svg]:text-primary-700" : "[&_svg]:text-primary-600";

  return (
    <div class="relative">
      <Show
        when={props.property}
        fallback={
          <button
            type="button"
            classList={chipClass()}
            onClick={() => void handleClick()}
          >
            <Show when={props.icon}>
              <div
                innerHTML={props.icon}
                class={`[&_svg]:inline [&_svg]:h-[18px] [&_svg]:w-[18px] ${iconClass()}`}
              />
            </Show>
            <span
              classList={{
                "text-primary-700": props.variant === "special",
                "text-primary-600": props.variant === "default",
              }}
            >
              {props.label}
            </span>
          </button>
        }
      >
        {(property) => (
          <button
            type="button"
            data-tooltip={
              props.showTooltip === false ? undefined : props.nameLabel || property().name
            }
            classList={chipClass()}
            onClick={() => void handleClick()}
          >
            <Show
              when={props.icon}
              fallback={
                <div class="flex h-[18px] w-[18px] items-center justify-center rounded-sm bg-primary-500" />
              }
            >
              <div
                innerHTML={props.icon}
                class={`[&_svg]:inline [&_svg]:h-[18px] [&_svg]:w-[18px] ${iconClass()}`}
              />
            </Show>
            <Show
              when={valueLabels().length > 0}
              fallback={
                <span
                  class={twMerge(
                    "max-w-[150px] overflow-hidden text-ellipsis whitespace-nowrap capitalize",
                    props.variant === "special" && "text-primary-700",
                    props.variant === "default" && "text-primary-600",
                  )}
                >
                  {props.label}
                </span>
              }
            >
              <span class="flex min-w-0 max-w-[260px] items-center gap-4xs overflow-hidden">
                <For each={valueLabels()}>
                  {(valueLabel) => (
                    <span class="max-w-[110px] overflow-hidden text-ellipsis whitespace-nowrap rounded-md bg-primary-50 px-4xs text-primary-600 capitalize">
                      {valueLabel}
                    </span>
                  )}
                </For>
              </span>
            </Show>
          </button>
        )}
      </Show>

      {/* Edit Property Popover */}
      <Show when={isEditPopoverOpen() && props.property}>
        {(property) => (
          <a-blur
            enabled
            on:exit={handleExit}
            class="absolute -top-4xs -left-4xs z-50 flex flex-col rounded-lg border border-neutral-100 bg-neutral-10 p-5xs shadow-large"
          >
            {/* Property name input with delete button */}
            <div class="flex w-full items-center gap-4xs px-3xs">
              <Show when={props.icon}>
                <div
                  innerHTML={props.icon}
                  class="[&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:text-neutral-950"
                />
              </Show>
              <div class="flex-1 overflow-hidden whitespace-nowrap py-5xs">
                <Show
                  when={property().type !== "date"}
                  fallback={<span class="text-interactive">{property().name}</span>}
                >
                  <input
                    ref={inputElement}
                    value={searchInput()}
                    onInput={(e) => setSearchInput(e.currentTarget.value)}
                    class="w-[150px] border-none bg-transparent text-interactive outline-none"
                    placeholder={props.nameLabel || property().name || t("Property name")}
                  />
                </Show>
              </div>
              <button
                type="button"
                class="shrink-0 cursor-pointer text-neutral-950 transition-opacity hover:opacity-70"
                aria-label={t("Delete property")}
                onClick={handleDelete}
              >
                <Icon name="trash" class="h-[18px] w-[18px]" />
              </button>
            </div>

            <Show
              when={property().type === "date"}
              fallback={
                <SelectMenu
                  items={filteredValueOptions()}
                  value={selectedValue() ?? null}
                  onSelect={handleValueSelect}
                />
              }
            >
              <div>
                <a-calendar
                  attr:value={dateValue()}
                  on:change={handleDateChange}
                  class="w-[250px] p-2"
                />
              </div>
            </Show>
          </a-blur>
        )}
      </Show>
    </div>
  );
}
