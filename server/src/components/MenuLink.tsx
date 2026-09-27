import { type JSX, Show } from "solid-js";
import { twMerge } from "tailwind-merge";
import { Icon, type IconName } from "./Icon.tsx";

interface Props {
  icon?: IconName;
  iconSvg?: string;
  text?: string;
  isActive?: boolean;
  href?: string;
  badge?: number;
  class?: string;
  children?: JSX.Element;
}

export function MenuLink(props: Props) {
  return (
    // biome-ignore lint/a11y/useValidAnchor: href is supplied by the caller.
    <a
      href={props.href}
      // Only the icon survives the collapsed sidebar, so the label moves into a
      // tooltip there. The layer suppresses it by itself while the label is on
      // screen, so this needs no width condition.
      data-tooltip={props.text}
      data-tooltip-pos="right"
      class={twMerge(
        props.class,
        // The left padding matches the quick search button's px-3xs plus its 1px
        // border, so every nav icon lines up on the same edge.
        "button-with-icon inline-flex cursor-pointer items-center rounded-md px-3xs font-normal text-neutral-800 transition-colors hover:transition-none w-full",
        "@max-xs:justify-start",
        props.isActive
          ? "bg-primary-100 text-primary-700"
          : "hover:bg-primary-50 active:bg-primary-100",
        "min-h-[32px]",
        "overflow-hidden whitespace-nowrap",
      )}
    >
      <div class="flex flex-1 items-center @max-xs:justify-start text-size-normal">
        <Icon name={props.icon} svg={props.iconSvg} />
        <span class="@max-xs:hidden">{props.text}</span>
      </div>

      {props.children}

      <Show when={props.badge !== undefined && props.badge > 0}>
        <span class="ml-auto rounded-sm bg-primary-100 px-1.5 py-0.5 font-medium text-neutral-800 text-size-extra-small">
          {props.badge}
        </span>
      </Show>
    </a>
  );
}
