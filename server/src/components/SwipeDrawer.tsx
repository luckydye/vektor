import type { JSX } from "solid-js";
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

/** A mobile panel on the right screen edge, pulled in by swiping left anywhere. */
export function SwipeDrawer(props: Props) {
  const t = useTranslation();
  const viewport = useVisualViewport();
  const width = () => viewport().width;

  const drawer = useSwipeDrawer({
    side: "right",
    size: width,
    openFromScreen: true,
    isOpen: () => props.open,
    setOpen: (open) => props.onUpdateOpen(open),
  });

  const isVisible = () => props.open || drawer.isDragging();

  return (
    <Portal>
      <div
        role="dialog"
        aria-label={props.title}
        inert={!isVisible()}
        class={twMerge(
          "fixed right-0 z-90 flex touch-pan-y p-1.5 transition-transform will-change-transform",
          isVisible() ? "translate-x-0" : "translate-x-full",
        )}
        style={{
          top: `${viewport().offsetTop}px`,
          height: `${viewport().height}px`,
          width: `${width()}px`,
          translate: drawer.translate(),
          transition: drawer.transition(),
        }}
        onTouchStart={drawer.startFromDrawer}
      >
        <div
          class={twMerge(
            "flex h-full w-full flex-col overflow-hidden rounded-lg border border-neutral-50 bg-neutral-10 transition-shadow",
            isVisible() && "shadow-2xl",
          )}
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
      </div>
    </Portal>
  );
}
