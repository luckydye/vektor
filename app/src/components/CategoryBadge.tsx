import type { JSX } from "solid-js";
import { twMerge } from "tailwind-merge";
import { getTextColor } from "#utils/color.ts";

/** What a badge needs from a category — the sidebar and the chips all have it. */
export interface CategoryBadgeData {
  name: string;
  color?: string;
  icon?: string;
}

interface Props {
  category: CategoryBadgeData;
  class?: string;
  children?: JSX.Element;
}

/**
 * The category's color square with its icon — an emoji or short text, falling
 * back to the initial. Children render on top of it, for the tree's chevron.
 */
export function CategoryBadge(props: Props) {
  return (
    <div
      class={twMerge(
        "relative flex h-[18px] w-[18px] flex-none items-center justify-center rounded-sm font-semibold text-size-extra-small",
        props.class,
      )}
      style={{
        "background-color": props.category.color || "#E5E7EB",
        color: getTextColor(props.category.color),
      }}
    >
      {props.children}
      <span class="block transition-opacity group-hover/category:opacity-0">
        {props.category.icon || props.category.name.charAt(0).toUpperCase()}
      </span>
    </div>
  );
}
