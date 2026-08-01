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
      {/* `on:click`, not `onClick`: Solid delegates `onClick` to the document,
          so `stopPropagation` there fires long after the event has bubbled
          through `a-list`. The list would select the item, emit `change`, and
          `ContextMenu` would click this button a second time — running the
          action twice, which reads as "nothing happened" for any action that
          toggles. A native listener stops the event before the list sees it. */}
      <button
        type="button"
        on:click={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onClick(event);
        }}
        class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs pr-4xs transition-colors hover:bg-primary-50 hover:transition-none active:bg-primary-100 group-aria-selected:bg-primary-10"
      >
        {props.children}
      </button>
    </a-list-item>
  );
}
