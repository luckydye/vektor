import { type JSX, mergeProps } from "solid-js";
import { twMerge } from "tailwind-merge";
import { Icon, type IconName } from "./Icon.tsx";

interface Props {
  icon: IconName;
  /** Required: an icon carries no accessible name of its own. */
  label: string;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  class?: string;
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>;
}

// Spelled out rather than assembled, so Tailwind's scanner reads every class as
// a literal, and merged rather than concatenated, so a caller's box or colour
// replaces these instead of tying with them on specificity.
const DEFAULT_CLASS =
  "button-icon w-7 h-7 [&_.svg-icon]:w-[18px] [&_.svg-icon]:h-[18px] text-neutral-500 enabled:hover:bg-neutral-100 enabled:hover:text-neutral-900 enabled:active:bg-neutral-200";

export function IconButton(props: Props) {
  const merged = mergeProps({ type: "button" as const }, props);

  return (
    <button
      type={merged.type}
      class={twMerge(DEFAULT_CLASS, merged.class)}
      disabled={merged.disabled}
      aria-label={merged.label}
      title={merged.label}
      onClick={merged.onClick}
    >
      <Icon name={merged.icon} />
    </button>
  );
}
