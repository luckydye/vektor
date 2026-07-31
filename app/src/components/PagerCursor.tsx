import { Show } from "solid-js";

interface Props {
  hasPrevPage: boolean;
  hasNextPage: boolean;
  disabled?: boolean;
  /** Keep the (disabled) buttons visible when there is only one page. */
  alwaysVisible?: boolean;
  /** Vue let `class` fall through to the root; Solid needs it declared. */
  class?: string;
  onPrev?: () => void;
  onNext?: () => void;
}

export function PagerCursor(props: Props) {
  return (
    <Show when={props.alwaysVisible || props.hasPrevPage || props.hasNextPage}>
      <div
        class={`flex items-center justify-between border-neutral-100 border-t ${props.class ?? ""}`}
      >
        <button
          type="button"
          disabled={props.disabled || !props.hasPrevPage}
          class="rounded-md border border-neutral-200 px-2.5 py-1 font-medium text-size-small transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => props.onPrev?.()}
        >
          Previous
        </button>
        <button
          type="button"
          disabled={props.disabled || !props.hasNextPage}
          class="rounded-md border border-neutral-200 px-2.5 py-1 font-medium text-size-small transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => props.onNext?.()}
        >
          Next
        </button>
      </div>
    </Show>
  );
}
