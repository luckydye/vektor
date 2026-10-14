import { createSignal, type JSX, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { useTranslation } from "#composeables/useTranslation.ts";
import { IconButton } from "./IconButton.tsx";

interface Props {
  title: string;
  /** Trailing header control, e.g. a delete button. */
  action?: JSX.Element;
  children?: JSX.Element;
  ref?: (element: HTMLDivElement) => void;
  onBack: () => void;
}

/**
 * A drill-down page sliding over its Dialog sheet. It renders into the panel rather than
 * in place, so the sheet's own content can slide aside beneath it (see `.sheet-page`).
 */
export function SheetPage(props: Props) {
  const t = useTranslation();
  const [panel, setPanel] = createSignal<HTMLElement>();
  let anchor: HTMLSpanElement | undefined;

  onMount(() => {
    const found = anchor?.closest<HTMLElement>(".dialog-panel");
    if (!found) throw new Error("SheetPage must render inside a Dialog");
    setPanel(found);
  });

  return (
    <>
      <span ref={anchor} hidden />
      <Show when={panel()}>
        {(mount) => (
          <Portal mount={mount()}>
            <div
              ref={props.ref}
              class="sheet-page absolute inset-0 z-10 flex flex-col bg-background"
            >
              <div class="flex flex-none items-center gap-1 px-3 pt-4 pb-2">
                <IconButton
                  icon="chevron-left-large"
                  label={t("Back")}
                  onClick={props.onBack}
                />
                <h2 class="min-w-0 flex-1 truncate font-semibold text-neutral-900 text-size-medium">
                  {props.title}
                </h2>
                {props.action}
              </div>
              <div class="flex min-h-0 flex-1 flex-col gap-3xs overflow-y-auto px-5 pb-5">
                {props.children}
              </div>
            </div>
          </Portal>
        )}
      </Show>
    </>
  );
}
