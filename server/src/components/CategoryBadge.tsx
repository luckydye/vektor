import { type JSX, Show } from "solid-js";
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
 * The category's color square with its uploaded image, emoji or short text,
 * falling back to the initial. Children render on top, for the tree's chevron.
 */
export function CategoryBadge(props: Props) {
  const isImageIcon = () => props.category.icon?.startsWith("data:image/") ?? false;

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
      <Show
        when={isImageIcon()}
        fallback={
          <span class="block transition-opacity group-hover/category:opacity-0">
            {props.category.icon || props.category.name.charAt(0).toUpperCase()}
          </span>
        }
      >
        <img
          src={props.category.icon}
          alt=""
          class="h-full w-full rounded-[inherit] object-cover transition-opacity group-hover/category:opacity-0"
        />
      </Show>
    </div>
  );
}
