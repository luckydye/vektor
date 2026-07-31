import { type IconName, icons } from "./iconMap.ts";

interface Props {
  name: IconName;
  /** Vue let `class` fall through to the root; Solid needs it declared. */
  class?: string;
}

export function Icon(props: Props) {
  return (
    <div
      innerHTML={icons[props.name]}
      class={`icon aspect-square flex-none [&_svg]:h-full [&_svg]:w-full ${props.class ?? ""}`}
      aria-hidden="true"
    />
  );
}
