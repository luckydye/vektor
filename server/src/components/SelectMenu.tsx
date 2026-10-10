import { createEffect, createSignal, For, mergeProps, on } from "solid-js";
import type { CategoryBadgeData } from "./CategoryBadge.tsx";
import type { IconName } from "./Icon.tsx";
import { SelectItem } from "./SelectItem.tsx";

export interface SelectMenuItem {
  id: string;
  label: string;
  icon?: IconName;
  iconSvg?: string;
  badge?: CategoryBadgeData;
}

interface Props {
  items?: SelectMenuItem[];
  value?: string | string[] | null;
  activeIndex?: number;
  onInput?: (value: string) => void;
  onSelect?: (item: SelectMenuItem) => void;
}

export function SelectMenu(props: Props) {
  const merged = mergeProps({ items: [] as SelectMenuItem[], value: null }, props);

  const isSelected = (id: string) =>
    Array.isArray(merged.value) ? merged.value.includes(id) : id === merged.value;

  return (
    <div class="flex max-h-[400px] w-full min-w-[180px] flex-col gap-[4px] overflow-y-auto py-[4px]">
      <For each={merged.items}>
        {(item, index) => (
          <SelectItem
            icon={item.icon}
            iconSvg={item.iconSvg}
            badge={item.badge}
            label={item.label}
            selected={isSelected(item.id)}
            active={index() === merged.activeIndex}
            onClick={() => {
              merged.onInput?.(item.id);
              merged.onSelect?.(item);
            }}
          />
        )}
      </For>
    </div>
  );
}

/** Arrow-key highlighting and Enter selection for a menu driven from a search input. */
export function useSelectMenuKeys(
  items: () => SelectMenuItem[],
  onSelect: (item: SelectMenuItem) => void,
) {
  const [activeIndex, setActiveIndex] = createSignal(0);
  createEffect(on(items, () => setActiveIndex(0)));

  function onKeyDown(event: KeyboardEvent) {
    const count = items().length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (count === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + step + count) % count);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = items()[activeIndex()];
      if (item) onSelect(item);
    }
  }

  return { activeIndex, onKeyDown };
}
