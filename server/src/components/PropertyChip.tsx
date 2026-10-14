import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { twMerge } from "tailwind-merge";
import type { Property } from "#documents/properties.ts";
import { CategoryBadge, type CategoryBadgeData } from "./CategoryBadge.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";
import { SheetPage } from "./SheetPage.tsx";
import { SelectMenu, type SelectMenuItem, useSelectMenuKeys } from "./SelectMenu.tsx";
import "@atrium-ui/elements/blur";
import "@atrium-ui/elements/calendar";
import { useTranslation } from "#composeables/useTranslation.ts";

interface Props {
  label?: string;
  labelClass?: string;
  nameLabel?: string;
  valueLabels?: string[];
  icon?: IconName;
  iconSvg?: string;
  badge?: CategoryBadgeData;
  variant?: "default" | "special" | "quiet";
  /** Fills its row and edits on a page covering the enclosing sheet, which would clip a popover. */
  sheet?: boolean;
  readonly?: boolean;
  property?: Property | null;
  allowMultiple?: boolean;
  showTooltip?: boolean;
  tooltipPos?: "bottom";
  propertyValues?: (property: Property) => Promise<SelectMenuItem[]>;
  onUpdate?: (property: Property & { search: string }) => void;
  onDelete?: (property: Property) => void;
}

export function PropertyChip(props: Props) {
  const t = useTranslation();

  let inputElement: HTMLInputElement | undefined;
  let rootElement: HTMLDivElement | undefined;
  // The sheet page renders into its Dialog's panel, outside the root.
  let pageElement: HTMLDivElement | undefined;

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

    // A sheet page slides in whole; options arriving mid-slide would reflow it.
    if (props.sheet && property.type !== "date") {
      setValueOptions((await props.propertyValues?.(property)) ?? []);
    }

    setIsEditPopoverOpen(!isEditPopoverOpen());
    setPropertyName(property.name);
    setSelectedValue(property.value);

    if (property.type === "date" && property.value && !Array.isArray(property.value)) {
      setDateValue(property.value);
    }

    if (props.sheet) return;

    await new Promise((resolve) => setTimeout(resolve, 25));

    if (property.type !== "date") {
      inputElement?.focus();

      props.propertyValues?.(property).then(setValueOptions);
    }
  };

  const filteredValueOptions = createMemo<SelectMenuItem[]>(() => {
    const searchTerm = searchInput().toLowerCase();
    const items = valueOptions().filter((item) =>
      item.label?.toLowerCase().includes(searchTerm),
    );
    if (items.length === 0) {
      return [
        {
          id: "__new__",
          label: t("Add {value}").replace("{value}", searchInput()),
          icon: "add",
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

    // Picking the value the property already has is a no-op, not an edit: it
    // would patch the document and bump its revision for nothing.
    if (itemValue !== selectedValue()) {
      setSelectedValue(itemValue);
      props.onUpdate?.({
        ...property,
        name: propertyName(),
        value: itemValue,
        search: searchInput(),
      });
    }

    handleExit();
  };

  const valueKeys = useSelectMenuKeys(filteredValueOptions, handleValueSelect);

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
      const target = e.target as Element | null;
      const outside = props.sheet
        ? !rootElement?.contains(target) && !pageElement?.contains(target)
        : !target?.closest("a-blur");
      if (outside && isEditPopoverOpen()) {
        handleExit();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    onCleanup(() => window.removeEventListener("pointerdown", onPointerDown));
  });

  const chipClass = () => ({
    "text-interactive flex items-center gap-4xs py-7xs pl-5xs pr-4xs rounded-md border transition-colors": true,
    "bg-primary-50 hover:bg-primary-100 border-primary-100": props.variant === "special",
    "bg-background hover:bg-primary-10 border-primary-200": props.variant === "default",
    "h-7 border-transparent hover:bg-neutral-100": props.variant === "quiet",
    "min-w-0 flex-1": !!props.sheet,
    "cursor-pointer": !!props.property && !props.readonly,
    "cursor-default": !props.property || !!props.readonly,
  });

  const textClass = () =>
    props.variant === "quiet"
      ? "text-neutral-900"
      : props.variant === "special"
        ? "text-primary-700"
        : "text-primary-600";

  const iconClass = () =>
    props.variant === "quiet"
      ? "[&_svg]:text-neutral-700"
      : props.variant === "special"
        ? "[&_svg]:text-primary-700"
        : "[&_svg]:text-primary-600";

  return (
    <div ref={rootElement} class={props.sheet ? "contents" : "relative"}>
      <Show
        when={props.property}
        fallback={
          <button
            type="button"
            classList={chipClass()}
            onClick={() => void handleClick()}
          >
            <Show when={props.icon}>
              <Icon
                class={`[&_svg]:inline [&_svg]:h-[18px] [&_svg]:w-[18px] ${iconClass()}`}
                name={props.icon}
              />
            </Show>
            <span class={textClass()}>{props.label}</span>
          </button>
        }
      >
        {(property) => (
          <button
            type="button"
            data-tooltip={
              props.showTooltip === false ? undefined : props.nameLabel || property().name
            }
            data-tooltip-pos={props.tooltipPos}
            classList={chipClass()}
            onClick={() => void handleClick()}
          >
            <Show
              when={props.badge}
              fallback={
                <Show
                  when={props.icon}
                  fallback={
                    <div class="flex h-[18px] w-[18px] items-center justify-center rounded-sm bg-primary-500" />
                  }
                >
                  <Icon
                    class={`[&_svg]:inline [&_svg]:h-[18px] [&_svg]:w-[18px] ${iconClass()}`}
                    name={props.icon}
                  />
                </Show>
              }
            >
              {(badge) => <CategoryBadge category={badge()} />}
            </Show>
            <Show
              when={valueLabels().length > 0}
              fallback={
                <span
                  class={twMerge(
                    "max-w-[150px] overflow-hidden text-ellipsis whitespace-nowrap capitalize",
                    textClass(),
                    props.labelClass,
                  )}
                >
                  {props.label}
                </span>
              }
            >
              <span
                class={twMerge(
                  "flex min-w-0 max-w-[260px] items-center gap-5xs overflow-hidden",
                  props.labelClass,
                )}
              >
                <For each={valueLabels()}>
                  {(valueLabel) => (
                    <span class="max-w-[110px] overflow-hidden text-ellipsis whitespace-nowrap rounded-sm bg-primary-50 px-5xs py-5xs text-primary-600 capitalize leading-none">
                      {valueLabel}
                    </span>
                  )}
                </For>
              </span>
            </Show>
          </button>
        )}
      </Show>

      <Show when={isEditPopoverOpen() && props.property}>
        {(property) => {
          const searchField = (inputClass: string, placeholder: string) => (
            <input
              ref={inputElement}
              value={searchInput()}
              onInput={(e) => setSearchInput(e.currentTarget.value)}
              onKeyDown={valueKeys.onKeyDown}
              class={inputClass}
              placeholder={placeholder}
            />
          );
          const deleteButton = () => (
            <IconButton
              icon="delete-element"
              label={t("Delete property")}
              onClick={handleDelete}
            />
          );
          const valuePicker = () => (
            <Show
              when={property().type === "date"}
              fallback={
                <SelectMenu
                  uncapped={props.sheet}
                  items={filteredValueOptions()}
                  value={selectedValue() ?? null}
                  activeIndex={valueKeys.activeIndex()}
                  onSelect={handleValueSelect}
                />
              }
            >
              <div class={props.sheet ? "flex justify-center" : undefined}>
                <a-calendar
                  attr:value={dateValue()}
                  on:change={handleDateChange}
                  class="w-[250px] p-2"
                />
              </div>
            </Show>
          );

          return (
            <Show
              when={props.sheet}
              fallback={
                <a-blur
                  enabled
                  on:exit={handleExit}
                  class="popover-enter absolute -top-[5px] -left-[5px] z-50 flex w-max max-w-[min(22rem,calc(100vw-2rem))] flex-col rounded-lg border border-neutral-100 bg-neutral-10 p-5xs shadow-large"
                >
                  {/* Border and padding match the chip, so the header sits exactly over it. */}
                  <div class="flex h-7 w-full items-center gap-4xs border border-transparent pr-4xs pl-5xs">
                    <Show when={props.badge}>
                      {(badge) => <CategoryBadge category={badge()} />}
                    </Show>
                    <Show when={!props.badge && props.icon}>
                      <Icon
                        class="h-[18px] w-[18px] text-neutral-950"
                        name={props.icon}
                        svg={props.iconSvg}
                      />
                    </Show>
                    <div class="flex-1 overflow-hidden whitespace-nowrap">
                      <Show
                        when={property().type !== "date"}
                        fallback={<span class="text-interactive">{property().name}</span>}
                      >
                        {searchField(
                          "w-[150px] border-none bg-transparent text-interactive outline-none",
                          props.nameLabel || property().name || t("Property name"),
                        )}
                      </Show>
                    </div>
                    <button
                      type="button"
                      class="shrink-0 cursor-pointer text-neutral-950 transition-opacity hover:opacity-70"
                      aria-label={t("Delete property")}
                      onClick={handleDelete}
                    >
                      <Icon name="delete-element" class="h-[18px] w-[18px]" />
                    </button>
                  </div>
                  {valuePicker()}
                </a-blur>
              }
            >
              <SheetPage
                title={props.nameLabel || property().name}
                action={deleteButton()}
                ref={(element) => {
                  pageElement = element;
                }}
                onBack={handleExit}
              >
                <Show when={property().type !== "date"}>
                  <div class="flex h-10 flex-none items-center gap-4xs rounded-lg border border-neutral-100 bg-neutral-50 px-3">
                    <Icon name="search" class="h-4 w-4 text-neutral-500" />
                    {searchField(
                      "min-w-0 flex-1 border-none bg-transparent text-interactive outline-none",
                      t("Search…"),
                    )}
                  </div>
                </Show>
                {valuePicker()}
              </SheetPage>
            </Show>
          );
        }}
      </Show>
    </div>
  );
}
