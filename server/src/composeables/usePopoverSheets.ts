import { createEffect, onCleanup, onMount } from "solid-js";
import { useSwipeDrawer } from "./useSwipeDrawer.ts";

// The panel of an open popover sheet; see `.popover-sheet` in components.css.
const PANEL_SELECTOR = ".popover-sheet[enabled] > * > *";

/**
 * Lets every open popover sheet be swiped down to dismiss. Sheets are plain
 * `a-popover`s restyled by CSS, so the panel under the finger is looked up on
 * each touch instead of being handed in.
 */
export function usePopoverSheets() {
  let panel: HTMLElement | null = null;

  function currentPanel() {
    if (!panel) throw new Error("No popover sheet is being swiped");
    return panel;
  }

  const drawer = useSwipeDrawer({
    side: "bottom",
    size: () => currentPanel().offsetHeight,
    // Only an open sheet's panel is found under a finger.
    isOpen: () => panel !== null,
    setOpen: (open) => {
      if (open) return;
      // The popover closes itself on an exit event from inside it.
      currentPanel().dispatchEvent(new CustomEvent("exit", { bubbles: true }));
    },
  });

  createEffect(() => {
    const translate = drawer.translate();
    const transition = drawer.transition();
    if (!panel) return;
    panel.style.translate = translate ?? "";
    panel.style.transition = transition ?? "";
  });

  function findPanel(e: TouchEvent) {
    const target = e.target;
    panel = target instanceof Element ? target.closest<HTMLElement>(PANEL_SELECTOR) : null;
    if (panel) drawer.startFromDrawer(e);
  }

  onMount(() => {
    document.addEventListener("touchstart", findPanel, { capture: true });
    onCleanup(() => document.removeEventListener("touchstart", findPanel, true));
  });
}
