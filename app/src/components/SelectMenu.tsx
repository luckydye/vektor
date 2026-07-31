import { For, mergeProps } from "solid-js";
import { SelectItem } from "./SelectItem.tsx";

export interface SelectMenuItem {
  id: string;
  label: string;
  icon?: string;
}

interface Props {
  items?: SelectMenuItem[];
  /** Two-way bound value. */
  value?: string | string[] | null;
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
        {(item) => (
          <SelectItem
            icon={item.icon}
            label={item.label}
            selected={isSelected(item.id)}
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
