/**
 * Hover tooltips for any `[data-tooltip]` element, drawn in one fixed layer on
 * `document.body`.
 *
 * Not a CSS pseudo-element on the trigger: the sidebar nests three overflow
 * clips (`sidebar-scroll`, `sidebar-panel` and the page wrapper), which cut a
 * pseudo-element off at the rail's edge. A single element outside all of them
 * is the only placement that survives.
 */

export {};

type Placement = "top" | "bottom" | "left" | "right";

/** Gap between the trigger and the bubble, matching the arrow's size. */
const OFFSET = 9;
/** Keeps the bubble off the very edge of the window. */
const MARGIN = 8;

let layer: HTMLDivElement | null = null;
let activeTrigger: HTMLElement | null = null;

function ensureLayer(): HTMLDivElement {
  if (layer?.isConnected) return layer;
  layer = document.createElement("div");
  layer.className = "tooltip-layer";
  layer.setAttribute("role", "tooltip");
  layer.setAttribute("aria-hidden", "true");
  document.body.append(layer);
  return layer;
}

function placementOf(trigger: HTMLElement): Placement {
  const raw = trigger.getAttribute("data-tooltip-pos");
  return raw === "bottom" || raw === "left" || raw === "right" ? raw : "top";
}

/**
 * Whether the label is already legible inside the trigger. A tooltip that only
 * repeats visible text is noise — this is what keeps the sidebar quiet when it
 * is expanded and loud when it is collapsed to icons.
 */
function labelAlreadyVisible(trigger: HTMLElement, text: string): boolean {
  // Walks text nodes, not elements: a wrapper's `textContent` also reads as the
  // label, and the wrapper stays visible when the label inside it is hidden.
  const walker = document.createTreeWalker(trigger, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim() !== text) continue;
    const holder = node.parentElement;
    if (!holder || holder.offsetParent === null) continue;
    const rect = holder.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
  }
  return false;
}

function position(bubble: HTMLDivElement, trigger: HTMLElement, placement: Placement) {
  const anchor = trigger.getBoundingClientRect();
  const { width, height } = bubble.getBoundingClientRect();

  let left: number;
  let top: number;
  switch (placement) {
    case "bottom":
      left = anchor.left + anchor.width / 2 - width / 2;
      top = anchor.bottom + OFFSET;
      break;
    case "left":
      left = anchor.left - width - OFFSET;
      top = anchor.top + anchor.height / 2 - height / 2;
      break;
    case "right":
      left = anchor.right + OFFSET;
      top = anchor.top + anchor.height / 2 - height / 2;
      break;
    default:
      left = anchor.left + anchor.width / 2 - width / 2;
      top = anchor.top - height - OFFSET;
  }

  const maxLeft = window.innerWidth - width - MARGIN;
  const maxTop = window.innerHeight - height - MARGIN;
  bubble.style.left = `${Math.max(MARGIN, Math.min(left, maxLeft))}px`;
  bubble.style.top = `${Math.max(MARGIN, Math.min(top, maxTop))}px`;
}

function show(trigger: HTMLElement) {
  const text = trigger.getAttribute("data-tooltip")?.trim();
  // Hides rather than returns: moving onto a trigger that wants no tooltip has
  // to dismiss whatever the last one left open.
  if (!text || labelAlreadyVisible(trigger, text)) {
    hide();
    return;
  }

  const bubble = ensureLayer();
  bubble.textContent = text;
  bubble.dataset.placement = placementOf(trigger);
  // Measured before it is shown, so the first frame is already in place.
  bubble.style.visibility = "hidden";
  bubble.dataset.open = "true";
  position(bubble, trigger, placementOf(trigger));
  bubble.style.visibility = "";
  bubble.setAttribute("aria-hidden", "false");
  activeTrigger = trigger;
}

function hide() {
  activeTrigger = null;
  if (!layer) return;
  delete layer.dataset.open;
  layer.setAttribute("aria-hidden", "true");
}

function triggerFrom(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>("[data-tooltip]");
}

document.addEventListener("pointerover", (event) => {
  const trigger = triggerFrom(event.target);
  if (trigger === activeTrigger) return;
  if (trigger) show(trigger);
  else hide();
});

document.addEventListener("focusin", (event) => {
  const trigger = triggerFrom(event.target);
  if (trigger) show(trigger);
});

document.addEventListener("focusout", hide);
// A drag never fires `pointerout`, so the bubble would hang around mid-drag.
document.addEventListener("dragstart", hide);
document.addEventListener("pointerdown", hide);
window.addEventListener("scroll", hide, true);
window.addEventListener("blur", hide);
