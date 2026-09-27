import { type JSX, Show } from "solid-js";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import "@atrium-ui/elements/popover";
import "@atrium-ui/elements/list";
import { useTranslation } from "#composeables/useTranslation.ts";

interface Props {
  children?: JSX.Element;
  ariaLabel?: string;
  placements?: string;
  /** Styles the built-in trigger without introducing a second SSR branch. */
  triggerVariant?: "secondary" | "outline";
  triggerClass?: string;
  /**
   * Replaces the default trigger button, which must carry `slot="trigger"`.
   * For a menu sitting on artwork, where the button's own styling would fight
   * the surface behind it.
   */
  trigger?: JSX.Element;
}

// A plain element, not an <a-list-item>: a-list only collects list items, so
// keyboard navigation skips the separator.
export function ContextMenuSeparator() {
  return <div class="my-5xs border-neutral-100 border-t" />;
}

function menuOrigin(placements = "bottom-end"): string {
  const preferredPlacement = placements.split(",", 1)[0]?.trim();
  switch (preferredPlacement) {
    case "bottom-start":
    case "right-start":
      return "origin-top-left";
    case "top-start":
      return "origin-bottom-left";
    case "top-end":
    case "left-end":
      return "origin-bottom-right";
    case "right-end":
      return "origin-bottom-left";
    case "left-start":
    case "bottom-end":
    default:
      return "origin-top-right";
  }
}

export function ContextMenu(props: Props) {
  const t = useTranslation();

  function handleSubmit(event: Event) {
    const detail = (event as CustomEvent<{ selected?: HTMLElement }>).detail;
    detail?.selected?.querySelector("button")?.click();
  }

  return (
    <a-popover-trigger class="group relative z-10 flex-none">
      <Show
        when={props.trigger}
        fallback={
          <Button
            variant={props.triggerVariant ?? "secondary"}
            slot="trigger"
            ariaLabel={props.ariaLabel ?? t("Document actions")}
            class={props.triggerClass ?? "px-4xs"}
          >
            <Icon name="context-menu-more" />
          </Button>
        }
      >
        {props.trigger}
      </Show>

      <a-popover class="group" placements={props.placements ?? "bottom-end"}>
        <div class="w-max p-2 opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
          <div
            class={`min-w-[100px] ${menuOrigin(props.placements)} scale-95 rounded-lg border border-neutral-100 bg-background p-5xs shadow-large transition-all duration-150 group-[&[enabled]]:scale-100`}
          >
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
