import { createSignal, onCleanup } from "solid-js";

// On mobile the layout viewport (`100vh`/`100dvh`, `window.innerHeight`) keeps
// its full size while an on-screen keyboard is up, so a bottom-anchored dialog
// or a full-height docked panel ends up behind the keyboard. The visual
// viewport is the part actually on screen; overlays position against it.

export interface Viewport {
  width: number;
  height: number;
  /** Offset of the visual viewport within the layout viewport (pinch-zoom, keyboard). */
  offsetLeft: number;
  offsetTop: number;
}

// The keyboard animates in; iOS reports the pre-animation size to the first
// resize event, so every update is re-read once the animation has settled.
const SETTLE_DELAY = 250;

// One set of listeners for all overlays, wired on first use.
let current: Viewport = { width: 0, height: 0, offsetLeft: 0, offsetTop: 0 };
let wired = false;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
const subscribers = new Set<(viewport: Viewport) => void>();

function measure(): Viewport {
  const vv = window.visualViewport;
  if (vv) {
    return {
      width: vv.width,
      height: vv.height,
      offsetLeft: vv.offsetLeft,
      offsetTop: vv.offsetTop,
    };
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    offsetLeft: 0,
    offsetTop: 0,
  };
}

function same(a: Viewport, b: Viewport): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.offsetLeft === b.offsetLeft &&
    a.offsetTop === b.offsetTop
  );
}

function read() {
  const next = measure();
  if (same(current, next)) return;
  current = next;
  for (const cb of subscribers) cb(current);
}

function update() {
  read();
  clearTimeout(settleTimer);
  settleTimer = setTimeout(read, SETTLE_DELAY);
}

function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  current = measure();

  window.visualViewport?.addEventListener("resize", update);
  window.visualViewport?.addEventListener("scroll", update);
  window.addEventListener("orientationchange", update);
  window.addEventListener("resize", update);
}

/**
 * The on-screen (visual) viewport rect, tracking keyboard and pinch-zoom.
 * Overlays size and position against it instead of `100dvh`.
 */
export function useVisualViewport() {
  wire();
  const [viewport, setViewport] = createSignal<Viewport>(current);

  subscribers.add(setViewport);
  onCleanup(() => subscribers.delete(setViewport));

  return viewport;
}

/** A fixed overlay layer's style covering exactly the visual viewport. */
export function viewportLayerStyle(viewport: Viewport) {
  return {
    top: `${viewport.offsetTop}px`,
    left: `${viewport.offsetLeft}px`,
    width: `${viewport.width}px`,
    height: `${viewport.height}px`,
  };
}
