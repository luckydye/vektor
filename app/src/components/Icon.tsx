import { type IconName, icons } from "./iconMap.ts";

interface Props {
  name: IconName;
}

export function Icon(props: Props) {
  return (
    <div
      innerHTML={icons[props.name]}
      class="icon aspect-square flex-none [&_svg]:h-full [&_svg]:w-full"
      aria-hidden="true"
    />
  );
}
