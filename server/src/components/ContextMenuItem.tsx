import type { JSX } from "solid-js";
import "@atrium-ui/elements/list";

interface Props {
  onClick: (event: Event) => void;
  class?: string;
  children?: JSX.Element;
}

export function ContextMenuItem(props: Props) {
  return (
    <a-list-item class={`group ${props.class ?? ""}`}>
      <button
        type="button"
        on:click={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onClick(event);
        }}
        class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs pr-4xs hover:bg-black/6 active:bg-black/10 group-aria-selected:bg-black/6 dark:active:bg-white/16 dark:hover:bg-white/10 dark:group-aria-selected:bg-white/10"
      >
        {props.children}
      </button>
    </a-list-item>
  );
}
