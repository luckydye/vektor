import { type JSX, mergeProps, Show } from "solid-js";
import { Icon, type IconName } from "./Icon.tsx";

interface Props {
  /** Visual family. Each maps to one `button-*` utility in `styles/theme.css`. */
  variant?: "primary" | "secondary" | "ghost" | "outline";
  /** Colour override layered on top of the variant. */
  tone?: "default" | "danger";
  size?: "medium" | "small";
  text?: string;
  /** Icon drawn before the text. Use `children` for anything richer. */
  icon?: IconName;
  /** Accessible name and tooltip. Required for icon-only buttons. */
  ariaLabel?: string;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  class?: string;
  form?: string;
  /** Slot assignment, for placement inside a custom element. */
  slot?: string;
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>;
  children?: JSX.Element;
}

// Written out in full: Tailwind scans source text, so an interpolated
// `button-${variant}` would never emit the utility.
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
