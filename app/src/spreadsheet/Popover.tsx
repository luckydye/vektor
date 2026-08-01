/**
 * The floating panels inside the spreadsheet: the right-click menu and the
 * toolbar's colour, border and number-format pickers.
 *
 * The app's `a-popover` is not usable here — it is styled with Tailwind, which
 * does not reach into the shadow root (see SpreadsheetHost.tsx). This is the
 * small amount of it we actually need.
 */

import { createEffect, createSignal, type JSX, onCleanup, Show } from "solid-js";

/**
 * Closes on Escape, on a pointer press outside `panel`, and on a resize.
 *
 * The outside test goes through `composedPath`: on a document listener
 * `event.target` is retargeted to the shadow host, so `panel.contains(target)`
 * is false even for a press on the panel itself, and the panel would dismiss
 * before the thing inside it could act.
 */
export function dismissOnOutsidePress(
  isOpen: () => boolean,
  panel: () => HTMLElement | undefined,
  close: () => void,
): void {
  createEffect(() => {
    if (!isOpen()) return;
    const onPointerDown = (event: PointerEvent) => {
      const element = panel();
      if (element && !event.composedPath().includes(element)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", close);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", close);
    });
  });
}

/** Keeps `panel` inside the window, below `anchor`. */
function position(panel: HTMLElement, anchor: HTMLElement): void {
  const trigger = anchor.getBoundingClientRect();
  const { width, height } = panel.getBoundingClientRect();
  const left = Math.max(8, Math.min(trigger.left, window.innerWidth - width - 8));
  // Flip above the trigger when there is no room under it.
  const below = trigger.bottom + 4;
  const top = below + height > window.innerHeight - 8 ? trigger.top - height - 4 : below;
  panel.style.left = `${left}px`;
  panel.style.top = `${Math.max(8, top)}px`;
}

interface Props {
  /** The button that opens it; receives the toggle. */
  trigger: (toggle: (event: MouseEvent) => void, isOpen: () => boolean) => JSX.Element;
  /** The panel's contents; receives a close callback for the items inside. */
  children: (close: () => void) => JSX.Element;
  /** Widened for the pickers, which lay out in a grid. */
  class?: string;
}

export function Popover(props: Props) {
  let anchor: HTMLElement | undefined;
  let panel: HTMLDivElement | undefined;
  const [isOpen, setIsOpen] = createSignal(false);

  const close = () => setIsOpen(false);
  dismissOnOutsidePress(isOpen, () => panel, close);

  createEffect(() => {
    if (isOpen() && panel && anchor) position(panel, anchor);
  });

  return (
    <span class="ic-popover-anchor" ref={anchor}>
      {props.trigger((event) => {
        event.stopPropagation();
        setIsOpen((open) => !open);
      }, isOpen)}
      <Show when={isOpen()}>
        <div class={`ic-menu ${props.class ?? ""}`} ref={panel}>
          {props.children(close)}
        </div>
      </Show>
    </span>
  );
}
