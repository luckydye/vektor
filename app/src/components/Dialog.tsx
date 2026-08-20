import { createEffect, type JSX, mergeProps, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { t } from "#utils/lang.ts";
import { lockScroll, unlockScroll } from "#utils/scrollLock.ts";
import "@atrium-ui/elements/blur";
import { IconButton } from "./IconButton.tsx";

interface Props {
  show?: boolean;
  title?: string;
  closeOnBackdrop?: boolean;
  maxWidth?: string;
  panelHeight?: string;
  bodyClass?: string;
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

  function onDismiss() {
    if (merged.closeOnBackdrop) close();
  }

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
              <IconButton
                class="-mr-1"
                icon="cancel"
                label={t("Close")}
                onClick={close}
              />
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
