import { type JSX, mergeProps, Show } from "solid-js";
import { Icon, type IconName } from "./Icon.tsx";

interface Props {
  icon?: IconName;
  /** Generated artwork — a category's colour badge — rather than a set icon. */
  iconSvg?: string;
  label?: string;
  selected?: boolean;
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>;
}

export function SelectItem(props: Props) {
  const merged = mergeProps({ label: "Item", selected: false }, props);

  return (
    <button
      type="button"
      class="flex w-full items-center gap-2.5 rounded-md px-4xs py-4xs text-left transition-colors [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:text-neutral-950"
      classList={{
        "bg-primary-50": merged.selected,
        "hover:bg-primary-10": !merged.selected,
      }}
      onClick={merged.onClick}
    >
      <Show when={merged.icon || merged.iconSvg}>
        <Icon
          class="h-[18px] w-[18px] shrink-0"
          name={merged.icon}
          svg={merged.iconSvg}
        />
      </Show>
      <span class="font-normal text-neutral-950 text-size-normal capitalize leading-[1rem]">
        {merged.label}
      </span>
    </button>
  );
}
