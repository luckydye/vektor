import { type Accessor, createMemo, createSignal } from "solid-js";
import type { CanvasView } from "#canvas/CanvasController.ts";
import type { CanvasHostElement } from "#canvas/CanvasHostElement.ts";

/**
 * The seam between the immediate-mode canvas and its Solid chrome.
 *
 * The canvas tracks nothing. It cannot say which value changed, only that it
 * painted — so that is all it reports, and this turns "painted" into a signal.
 *
 * Chrome reads the canvas through `frame(...)`, which re-runs the read once per
 * painted frame. That sounds expensive during a drag and is not: the reads are
 * property lookups, and a memo whose result is unchanged stops there, so the
 * DOM is only touched when something the chrome actually shows has moved.
 *
 * The alternative — mirroring each value into its own signal — would put the
 * canvas back in the business of knowing what changed, which is the thing that
 * was deliberately removed from it.
 */
export interface CanvasChrome {
  /** Null until the element has started. */
  view: Accessor<CanvasView | null>;
  /** Re-read the canvas once per painted frame. */
  frame<T>(read: () => T): Accessor<T>;
  /**
   * Run a canvas command from the chrome, then repaint.
   *
   * Chrome lives outside the element, so it misses the host's own input
   * listener; this is the same "input, update, draw" step, said explicitly.
   */
  run(command: (view: CanvasView) => void): void;
  /** Called by the host after each paint. */
  onFrame(): void;
}

/**
 * Chrome sits above the viewport, which starts a drag on pointerdown.
 *
 * Every panel needs this on its outermost element, so it lives with the bridge
 * rather than being redefined in each one.
 */
export const swallowPointer = (event: PointerEvent) => event.stopPropagation();

export function createCanvasChrome(
  host: () => CanvasHostElement | undefined,
): CanvasChrome {
  // Bumped per paint. `equals: false` because the count is not the point —
  // every paint has to invalidate, including one that lands on the same number.
  const [painted, setPainted] = createSignal(0, { equals: false });

  const view = createMemo(() => {
    painted();
    return host()?.view ?? null;
  });

  return {
    view,
    frame<T>(read: () => T): Accessor<T> {
      return createMemo(() => {
        painted();
        return read();
      });
    },
    run(command) {
      const current = view();
      if (!current) return;
      command(current);
      host()?.requestFrame();
    },
    onFrame() {
      setPainted((count) => count + 1);
    },
  };
}
