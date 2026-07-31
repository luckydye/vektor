import { type JSX, mergeProps } from "solid-js";

interface Props {
  label?: string;
  children?: JSX.Element;
}

export function FormField(props: Props) {
  const merged = mergeProps({ label: "Field Label" }, props);

  return (
    <div class="flex flex-1 flex-col gap-[4px]">
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is supplied by the caller as children. */}
      <label class="font-medium text-[12px] text-neutral-800 leading-[1.5em]">
        {merged.label}
      </label>
      {merged.children}
    </div>
  );
}
