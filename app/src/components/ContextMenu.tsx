import type { JSX } from "solid-js";
import { t } from "#utils/lang.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import "@atrium-ui/elements/popover";
import "@atrium-ui/elements/list";

interface Props {
  children?: JSX.Element;
}

// A plain element, not an <a-list-item>: a-list only collects list items, so
// keyboard navigation skips the separator.
export function ContextMenuSeparator() {
  return <div class="my-5xs border-neutral-100 border-t" />;
}

export function ContextMenu(props: Props) {
  function handleSubmit(event: Event) {
    const detail = (event as CustomEvent<{ selected?: HTMLElement }>).detail;
    detail?.selected?.querySelector("button")?.click();
  }

  return (
    <a-popover-trigger class="group relative z-10 flex-none">
      <Button
        variant="secondary"
        slot="trigger"
        ariaLabel={t("Document actions")}
        class="px-4xs"
      >
        <Icon name="context-menu-more" />
      </Button>

      <a-popover class="group" placements="bottom-end">
        <div class="w-max py-2 opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
          <div class="min-w-[100px] origin-top-right scale-95 rounded-lg border border-neutral-100 bg-background p-5xs shadow-large transition-all duration-150 group-[&[enabled]]:scale-100">
            <a-list
              on:change={handleSubmit}
              class="max-h-screen w-full min-w-[150px] space-y-5xs overflow-auto text-interactive outline-none"
            >
              {props.children}
            </a-list>
          </div>
        </div>
      </a-popover>
    </a-popover-trigger>
  );
}
