import { type JSX, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { twMerge } from "tailwind-merge";
import { useSwipeDrawer } from "#composeables/useSwipeDrawer.ts";
import { useTranslation } from "#composeables/useTranslation.ts";
import { useVisualViewport } from "#composeables/useVisualViewport.ts";
import { IconButton } from "./IconButton.tsx";

interface Props {
  title: string;
  open: boolean;
  onUpdateOpen: (open: boolean) => void;
  children?: JSX.Element;
}

// The strip of page left uncovered beside the drawer; tapping or swiping it closes the drawer.
const UNCOVERED_WIDTH = 40;

/** A mobile panel on the right screen edge, pulled in by swiping left anywhere. */
export function SwipeDrawer(props: Props) {
  const t = useTranslation();
  const viewport = useVisualViewport();
  const width = () => viewport().width - UNCOVERED_WIDTH;

  const drawer = useSwipeDrawer({
    side: "right",
    width,
    isOpen: () => props.open,
    setOpen: (open) => props.onUpdateOpen(open),
  });

  const isVisible = () => props.open || drawer.isDragging();

  return (
    <Portal>
      <Show when={props.open}>
        <button
          type="button"
          class="fixed left-0 z-90 touch-pan-y border-0 bg-transparent"
          style={{
            top: `${viewport().offsetTop}px`,
            height: `${viewport().height}px`,
            width: `${UNCOVERED_WIDTH}px`,
          }}
          aria-label={t("Close")}
          onTouchStart={drawer.startFromDrawer}
          onClick={() => props.onUpdateOpen(false)}
        />
      </Show>

      <div
        role="dialog"
        aria-label={props.title}
        inert={!isVisible()}
        class={twMerge(
          "fixed right-0 z-90 flex touch-pan-y flex-col overflow-hidden rounded-l-lg border-neutral-100 border-l bg-neutral-10 transition-transform will-change-transform",
          isVisible() ? "translate-x-0 shadow-2xl" : "translate-x-full",
        )}
        style={{
          top: `${viewport().offsetTop}px`,
          height: `${viewport().height}px`,
          width: `${width()}px`,
          transform: drawer.transform(),
          transition: drawer.isDragging() ? "none" : undefined,
        }}
        onTouchStart={drawer.startFromDrawer}
      >
        <div class="flex shrink-0 items-center gap-2 border-neutral-100 border-b px-3 py-2.5">
          <span class="flex-1 font-semibold text-neutral-800 text-size-medium">
            {props.title}
          </span>
          <IconButton
            icon="cancel"
            label={t("Close")}
            onClick={() => props.onUpdateOpen(false)}
          />
        </div>

        <div class="min-h-0 flex-1 overflow-hidden">{props.children}</div>
      </div>
    </Portal>
  );
}
