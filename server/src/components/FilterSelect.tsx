import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import { useTranslation } from "#composeables/useTranslation.ts";
import { Icon } from "./Icon.tsx";

export interface FilterSelectOption {
  value: string;
  label: string;
  /** Second line under the label, searched along with it. */
  description?: string;
  /** Leading content such as an avatar, shown in the row and in the trigger. */
  icon?: () => JSX.Element;
  /** Heading the option is listed under; ungrouped options come first. */
  group?: string;
}

interface Props {
  id?: string;
  class?: string;
  value: string;
  options: FilterSelectOption[];
  placeholder?: string;
  filterPlaceholder?: string;
  /** Leading content for the trigger while no listed option is selected. */
  fallbackIcon?: () => JSX.Element;
  /**
   * Offers the typed text as its own entry, so a value the options do not hold
   * yet — the email of someone who is not a member — can still be picked.
   * Return null to reject the text.
   */
  customValue?: (query: string) => FilterSelectOption | null;
  onChange: (value: string) => void;
}

/**
 * How many matches are rendered at once. A space can hold thousands of pages,
 * and a list that long is unreadable rather than useful — the count of what is
 * hidden is shown so the list never silently pretends to be complete.
 */
const VISIBLE_LIMIT = 50;

const PANEL_MAX_HEIGHT = 320;
const PANEL_MIN_HEIGHT = 140;
const PANEL_GAP = 4;
/**
 * The panel's own border plus padding. The filter input is inset by this much,
 * so the panel is grown and shifted by it for the input to land exactly on the
 * trigger it replaces.
 */
const PANEL_INSET = 5;

/**
 * A select whose options are searched rather than scrolled. The panel is
 * portalled and laid over the trigger: the dialogs that use this scroll their
 * body and clip absolutely positioned children, and a panel opened in flow
 * would push the rest of the form around.
 */
export function FilterSelect(props: Props) {
  const t = useTranslation();

  const [isOpen, setIsOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [box, setBox] = createSignal({
    left: 0,
    top: 0,
    width: 0,
    inputHeight: 0,
    maxHeight: 0,
  });

  let triggerElement: HTMLButtonElement | undefined;
  let panelElement: HTMLDivElement | undefined;
  let inputElement: HTMLInputElement | undefined;
  /** By index, so the active row is found again after the list re-renders. */
  const itemElements: HTMLButtonElement[] = [];
  /** Only keyboard moves scroll; a hover-driven move is already in view. */
  let scrollActiveIntoView = false;

  const selected = createMemo(() =>
    props.options.find((option) => option.value === props.value),
  );

  const matches = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) return props.options;
    return props.options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) ||
        !!option.description?.toLowerCase().includes(needle),
    );
  });

  /** The typed text as an entry of its own, once it is not already listed. */
  const custom = createMemo(() => {
    const needle = query().trim();
    if (!needle || !props.customValue) return null;
    const option = props.customValue(needle);
    if (!option) return null;
    if (props.options.some((existing) => existing.value === option.value)) return null;
    return option;
  });

  const visible = createMemo(() => {
    const listed = matches().slice(0, VISIBLE_LIMIT);
    const typed = custom();
    return typed ? [...listed, typed] : listed;
  });

  const groups = createMemo(() => {
    const byGroup = new Map<
      string,
      Array<{ option: FilterSelectOption; index: number }>
    >();
    visible().forEach((option, index) => {
      const key = option.group ?? "";
      const entries = byGroup.get(key);
      if (entries) entries.push({ option, index });
      else byGroup.set(key, [{ option, index }]);
    });
    return [...byGroup].map(([label, entries]) => ({ label, entries }));
  });

  /**
   * The filter input takes the trigger's place, so the panel starts at the
   * trigger's own top edge and only slides up to stay in the viewport.
   */
  function measure() {
    const rect = triggerElement?.getBoundingClientRect();
    if (!rect) return;
    const left = rect.left - PANEL_INSET;
    const width = rect.width + PANEL_INSET * 2;
    const top = rect.top - PANEL_INSET;
    const room = window.innerHeight - top - PANEL_GAP;
    // Only a trigger too close to the bottom edge pulls the panel off it.
    if (room >= PANEL_MIN_HEIGHT) {
      setBox({
        left,
        top,
        width,
        inputHeight: rect.height,
        maxHeight: Math.min(PANEL_MAX_HEIGHT, room),
      });
      return;
    }
    const maxHeight = Math.min(PANEL_MAX_HEIGHT, window.innerHeight - PANEL_GAP * 2);
    setBox({
      left,
      top: Math.max(PANEL_GAP, window.innerHeight - PANEL_GAP - maxHeight),
      width,
      inputHeight: rect.height,
      maxHeight,
    });
  }

  function close() {
    setIsOpen(false);
    setQuery("");
  }

  function select(option: FilterSelectOption) {
    props.onChange(option.value);
    close();
    triggerElement?.focus();
  }

  createEffect(on(matches, () => setActiveIndex(0)));
  createEffect(
    on(activeIndex, (index) => {
      if (!scrollActiveIntoView) return;
      scrollActiveIntoView = false;
      itemElements[index]?.scrollIntoView({ block: "nearest" });
    }),
  );

  createEffect(() => {
    if (!isOpen()) return;
    measure();
    inputElement?.focus();

    // Capture, so scrolling the dialog body under the panel repositions it.
    const reposition = () => measure();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (panelElement?.contains(target)) return;
      if (triggerElement?.contains(target)) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);

    onCleanup(() => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("pointerdown", onPointerDown, true);
    });
  });

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const count = visible().length;
      if (count === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      scrollActiveIntoView = true;
      setActiveIndex((index) => (index + step + count) % count);
      return;
    }
    // Without this the Enter would submit the surrounding form.
    if (event.key === "Enter") {
      event.preventDefault();
      const option = visible()[activeIndex()];
      if (option) select(option);
      return;
    }
    // The dialog closes on a window-level Escape, so it must not see this one.
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      triggerElement?.focus();
    }
  }

  return (
    <>
      <button
        ref={triggerElement}
        id={props.id}
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        class={`flex w-full min-w-0 items-center gap-1.5 rounded-md border border-neutral-200 bg-background px-2.5 py-1.5 text-left focus:outline-none focus:ring-1 focus:ring-neutral-400 ${props.class ?? ""}`}
        // The panel covers this button, whose border would otherwise show
        // around the panel's inset edge.
        classList={{ invisible: isOpen() }}
      >
        <Show when={selected()?.icon ?? props.fallbackIcon}>
          {(icon) => <span class="flex flex-none items-center">{icon()()}</span>}
        </Show>
        <span
          class="min-w-0 flex-1 truncate text-size-medium"
          classList={{
            "text-neutral-900": !!selected() || !!props.value,
            "text-neutral-400": !selected() && !props.value,
          }}
        >
          {selected()?.label ?? props.value ?? ""}
          <Show when={!selected() && !props.value}>
            {props.placeholder ?? t("Select…")}
          </Show>
        </span>
        <Icon class="h-4 w-4 flex-none text-neutral-400" name="chevron-down" />
      </button>

      <Show when={isOpen()}>
        <Portal>
          <div
            ref={panelElement}
            class="fixed z-200 flex flex-col gap-5xs overflow-hidden rounded-lg border border-neutral-100 bg-neutral-10 p-5xs shadow-large"
            style={{
              left: `${box().left}px`,
              top: `${box().top}px`,
              width: `${box().width}px`,
              "max-height": `${box().maxHeight}px`,
            }}
          >
            <div
              class="flex flex-none items-center gap-5xs rounded-md border border-black/15 bg-background px-4xs"
              style={{ height: `${box().inputHeight}px` }}
            >
              <Icon class="h-4 w-4 flex-none text-neutral-400" name="search" />
              <input
                ref={inputElement}
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={onKeyDown}
                type="text"
                autocomplete="off"
                placeholder={props.filterPlaceholder ?? t("Search…")}
                class="min-w-0 flex-1 bg-transparent font-normal text-neutral-950 text-size-medium outline-none placeholder:opacity-40"
              />
            </div>

            <Show
              when={visible().length > 0}
              fallback={
                <p class="flex-none px-4xs py-4xs text-neutral-400 text-size-small">
                  {t("No matches")}
                </p>
              }
            >
              <ul class="flex min-h-0 flex-1 flex-col gap-5xs overflow-y-auto">
                <For each={groups()}>
                  {(group) => (
                    <li>
                      <Show when={group.label}>
                        <div class="px-4xs py-5xs text-neutral-400 text-size-small">
                          {group.label}
                        </div>
                      </Show>
                      <ul class="flex flex-col gap-5xs">
                        <For each={group.entries}>
                          {(entry) => (
                            <li>
                              <button
                                ref={(element) => {
                                  itemElements[entry.index] = element;
                                }}
                                type="button"
                                // Keeps focus in the filter input, so the panel
                                // does not close before the click lands.
                                onMouseDown={(event) => event.preventDefault()}
                                onMouseEnter={() => setActiveIndex(entry.index)}
                                onClick={() => select(entry.option)}
                                class="flex w-full items-center gap-4xs rounded-md px-4xs py-4xs text-left font-normal text-neutral-950 text-size-normal transition-colors"
                                classList={{
                                  "bg-primary-50": entry.index === activeIndex(),
                                  "font-medium": entry.option.value === props.value,
                                }}
                              >
                                <Show when={entry.option.icon}>
                                  {(icon) => (
                                    <span class="flex flex-none items-center">
                                      {icon()()}
                                    </span>
                                  )}
                                </Show>
                                <span class="min-w-0 flex-1">
                                  <span class="block truncate leading-[1rem]">
                                    {entry.option.label}
                                  </span>
                                  <Show when={entry.option.description}>
                                    <span class="mt-5xs block truncate text-neutral-400 text-size-small">
                                      {entry.option.description}
                                    </span>
                                  </Show>
                                </span>
                              </button>
                            </li>
                          )}
                        </For>
                      </ul>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={matches().length > visible().length}>
                <p class="flex-none px-4xs py-5xs text-neutral-400 text-size-small">
                  {t("{count} more — keep typing to narrow the list").replace(
                    "{count}",
                    String(matches().length - visible().length),
                  )}
                </p>
              </Show>
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  );
}
