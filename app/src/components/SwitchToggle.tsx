import { play } from "cuelume";
import { Show } from "solid-js";

interface Props {
  /** Two-way bound value. Solid spells this `value` + `onInput` (plan §10). */
  value: boolean;
  disabled?: boolean;
  label?: string;
  onInput?: (value: boolean) => void;
}

export function SwitchToggle(props: Props) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the input below is the control.
    <label
      class="inline-flex items-center gap-2"
      classList={{
        "cursor-not-allowed": props.disabled,
        "cursor-pointer": !props.disabled,
      }}
    >
      <input
        type="checkbox"
        class="peer sr-only"
        checked={props.value}
        disabled={props.disabled}
        role="switch"
        aria-checked={props.value}
        onChange={(event) => {
          play("toggle");
          props.onInput?.(event.currentTarget.checked);
        }}
      />
      <span class="relative inline-flex h-5 w-9 shrink-0 rounded-full bg-neutral-200 transition-colors after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:bg-green-600 peer-checked:after:translate-x-4 peer-focus-visible:outline-2 peer-focus-visible:outline-blue-500 peer-focus-visible:outline-offset-2 peer-disabled:opacity-50" />
      <Show when={props.label}>
        <span class="text-neutral-700 text-size-small">{props.label}</span>
      </Show>
    </label>
  );
}
