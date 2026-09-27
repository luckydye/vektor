import { type JSX, mergeProps, Show } from "solid-js";
import { Icon, type IconName } from "./Icon.tsx";

interface Props {
  variant?: "primary" | "secondary" | "ghost" | "outline";
  tone?: "default" | "danger";
  size?: "medium" | "small";
  text?: string;
  icon?: IconName;
  ariaLabel?: string;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  class?: string;
  form?: string;
  slot?: string;
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>;
  children?: JSX.Element;
}

const VARIANT_CLASS = {
  primary: "button-primary",
  secondary: "button-secondary",
  ghost: "button-ghost",
  outline: "button-outline",
} as const;

export function Button(props: Props) {
  const merged = mergeProps(
    {
      variant: "primary" as const,
      tone: "default" as const,
      size: "medium" as const,
      type: "button" as const,
    },
    props,
  );

  const classes = () =>
    [
      VARIANT_CLASS[merged.variant],
      merged.tone === "danger" && "button-danger",
      merged.size === "small" && "button-small",
      merged.class,
    ]
      .filter(Boolean)
      .join(" ");

  return (
    <button
      type={merged.type}
      class={classes()}
      disabled={merged.disabled}
      aria-label={merged.ariaLabel}
      title={merged.ariaLabel}
      form={merged.form}
      slot={merged.slot}
      onClick={merged.onClick}
    >
      {merged.children}
      <Show when={merged.icon}>
        <Icon class="icon" name={merged.icon} />
      </Show>
      <Show when={merged.text}>
        <span>{merged.text}</span>
      </Show>
    </button>
  );
}
