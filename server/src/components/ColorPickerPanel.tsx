import "@atrium-ui/elements/color-picker";
import { Show } from "solid-js";
import { useTranslation } from "#composeables/useTranslation.ts";
import { PRESET_COLORS, TRANSPARENT_COLOR } from "#utils/color.ts";
import { Button } from "./Button.tsx";

/** The palette swatches and focus outline of `a-color-picker`, matched to the app's controls. */
export const COLOR_PICKER_CLASS =
  "w-[220px] [--color-picker-border:var(--control-border)] [--color-picker-focus-outline:var(--color-neutral-900)] [--color-picker-swatch-size:1.25rem] [&::part(palette-swatch)]:rounded-full";

interface Props {
  /** A `#rrggbb` hex, or `TRANSPARENT_COLOR` when `allowTransparent` is set. */
  value: string;
  /** Offers a "No color" choice below the picker. */
  allowTransparent?: boolean;
  onUpdateValue?: (value: string) => void;
}

/** The colour picker with the preset colours, for a popover. */
export function ColorPickerPanel(props: Props) {
  const t = useTranslation();
  const isTransparent = () => props.value === TRANSPARENT_COLOR;

  return (
    <div class="flex flex-col gap-2">
      <a-color-picker
        class={COLOR_PICKER_CLASS}
        attr:palette={PRESET_COLORS.join(",")}
        attr:value={isTransparent() ? PRESET_COLORS[0] : props.value}
        on:change={(event: Event) =>
          props.onUpdateValue?.((event.target as HTMLElement & { value: string }).value)
        }
      />
      <Show when={props.allowTransparent}>
        <Button
          variant="neutral"
          size="small"
          class="justify-center"
          disabled={isTransparent()}
          text={t("No color")}
          onClick={() => props.onUpdateValue?.(TRANSPARENT_COLOR)}
        />
      </Show>
    </div>
  );
}
