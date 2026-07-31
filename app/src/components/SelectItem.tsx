import { type JSX, mergeProps, Show } from "solid-js";

interface Props {
  icon?: string;
  label?: string;
  selected?: boolean;
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>;
}

export function SelectItem(props: Props) {
  const merged = mergeProps({ label: "Item", selected: false }, props);

  return (
    <button
      type="button"
      class="flex w-full items-center gap-2.5 rounded-md px-3xs py-4xs text-left transition-colors [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:text-neutral-950"
      classList={{
        "bg-primary-50": merged.selected,
        "hover:bg-primary-10": !merged.selected,
      }}
      onClick={merged.onClick}
    >
      <Show when={merged.icon}>
        <div innerHTML={merged.icon} class="h-[18px] w-[18px] shrink-0" />
      </Show>
      <span class="font-normal text-neutral-950 text-size-normal capitalize leading-[1rem]">
        {merged.label}
      </span>
    </button>
  );
}
