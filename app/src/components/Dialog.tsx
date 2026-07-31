import { createEffect, type JSX, mergeProps, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { cancelIcon } from "#assets/icons.ts";
import { t } from "#utils/lang.ts";
import { lockScroll, unlockScroll } from "#utils/scrollLock.ts";
import "@atrium-ui/elements/blur";

interface Props {
  show?: boolean;
  title?: string;
  /** Allow dismissing via backdrop click or Escape. */
  closeOnBackdrop?: boolean;
  /** Desktop max-width utility class (mobile is always full-width). */
  maxWidth?: string;
  /** Optional fixed panel height. Content still scrolls within the body. */
  panelHeight?: string;
  /**
   * Override body classes (padding + overflow). Pass e.g. "p-0" for full-bleed
   * content, or your own overflow for self-scrolling content.
   */
  bodyClass?: string;
  /**
   * Fill to a fixed tall height instead of fitting content. Needed for content
   * that manages its own internal scroll (e.g. docked panels): a definite
   * height lets a child's `h-full`/`flex-1` scroll region resolve.
   */
  expand?: boolean;
  header?: JSX.Element;
  footer?: JSX.Element;
  children?: JSX.Element;
  onUpdateShow?: (value: boolean) => void;
  onClose?: () => void;
}

export function Dialog(props: Props) {
  const merged = mergeProps(
    {
      show: false,
      title: "",
      closeOnBackdrop: true,
      maxWidth: "md:max-w-md",
      panelHeight: "",
      bodyClass: "px-5 pt-1 pb-5 overflow-y-auto",
      expand: false,
    },
    props,
  );

  function close() {
    merged.onUpdateShow?.(false);
    merged.onClose?.();
  }

  // Backdrop click and <a-blur>'s exit event (Escape / focus-out) are the
  // dismissal paths; both respect closeOnBackdrop. The header ✕ always closes.
  function onDismiss() {
    if (merged.closeOnBackdrop) close();
  }

  // Ref-counted body scroll lock so a closing dialog cannot unlock the page
  // while another overlay (e.g. the mobile sidebar) is still open.
  let holdsLock = false;
  function applyScrollLock(shouldLock: boolean) {
    if (shouldLock && !holdsLock) {
      lockScroll();
      holdsLock = true;
    } else if (!shouldLock && holdsLock) {
      unlockScroll();
      holdsLock = false;
    }
  }

  createEffect(() => applyScrollLock(merged.show));
  onCleanup(() => applyScrollLock(false));

  return (
    <Portal>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a-blur emits dismissal events for this modal container. */}
      <a-blur
        // `undefined`, not `false`: on a custom element Solid writes the
        // attribute verbatim, so `hidden={false}` renders `hidden="false"` —
        // present, and therefore hiding the dialog it was meant to reveal.
        attr:hidden={merged.show ? undefined : ""}
        attr:enabled={merged.show ? "" : undefined}
        class="dialog-layer fixed inset-0 z-100 flex items-end justify-center md:items-center"
        on:exit={onDismiss}
      >
        <button
          type="button"
          class="dialog-backdrop absolute inset-0 border-0 bg-black/40 md:bg-black/50"
          aria-label={t("Close dialog")}
          onClick={onDismiss}
        />

        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the handler only stops the click reaching the dismissal layer; keyboard dismissal is a-blur's exit event. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: this is the modal container, not a control. */}
        <div
          role="dialog"
          aria-modal="true"
          class={`dialog-panel relative flex w-full flex-col overflow-hidden rounded-t-2xl bg-background shadow-xl md:rounded-2xl ${merged.maxWidth} ${merged.panelHeight} ${
            merged.expand ? "h-[90dvh] md:h-[85vh]" : "max-h-[90dvh] md:max-h-[85vh]"
          }`}
          onClick={(event) => event.stopPropagation()}
        >
          {/* Mobile grab handle */}
          <div class="flex flex-none justify-center pt-2 pb-1 md:hidden">
            <div class="h-1 w-9 rounded-full bg-neutral-300" />
          </div>

          <Show when={merged.title || merged.header}>
            <div class="flex flex-none items-center justify-between gap-3 px-5 pt-3 pb-2 md:pt-4">
              <Show
                when={merged.header}
                fallback={
                  <h2 class="font-semibold text-neutral-900 text-size-medium">
                    {merged.title}
                  </h2>
                }
              >
                {merged.header}
              </Show>
              <button
                type="button"
                class="-mr-1 flex-none rounded-md p-1 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
                aria-label={t("Close")}
                onClick={close}
              >
                <div class="svg-icon h-4 w-4" innerHTML={cancelIcon} />
              </button>
            </div>
          </Show>

          <div class={`min-h-0 flex-1 ${merged.bodyClass}`}>{merged.children}</div>

          <Show when={merged.footer}>
            <div class="flex-none border-neutral-100 border-t px-5 py-4">
              {merged.footer}
            </div>
          </Show>
        </div>
      </a-blur>
    </Portal>
  );
}
