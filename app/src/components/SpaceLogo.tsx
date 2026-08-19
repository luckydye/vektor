import { Show } from "solid-js";
import { Icon } from "./Icon.tsx";

interface Props {
  /** Inline SVG markup or the URL of an uploaded image. */
  logoSvg?: string;
  class?: string;
  fallbackClass?: string;
}

/** A space's own mark, or the generic one for a space that has not set one. */
export function SpaceLogo(props: Props) {
  return (
    <Show
      when={props.logoSvg}
      fallback={<Icon class={props.fallbackClass ?? "text-white"} name="home" />}
    >
      <Show
        when={props.logoSvg?.startsWith("<")}
        fallback={<img src={props.logoSvg} alt="" class={props.class} />}
      >
        <Icon class="text-white" svg={props.logoSvg} />
      </Show>
    </Show>
  );
}
