const ENTER: Keyframe[] = [
  { opacity: 0, transform: "translateY(8px)" },
  { opacity: 1, transform: "none" },
];

const EXIT: Keyframe[] = [
  { opacity: 1, transform: "none" },
  { opacity: 0, transform: "translateY(-4px)" },
];

const TIMING: KeyframeAnimationOptions = { duration: 200, easing: "ease" };

/** Slack over the animation's own duration before a caller should give up on it. */
export const EXIT_TIMEOUT_MS = 400;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Element-scoped enter/leave animation.
 *
 * Per-element rather than document-scoped on purpose: toasts arrive and expire
 * on independent timers, so they overlap by construction. A View Transition is
 * document-wide and only one runs at a time, so overlapping toasts would keep
 * interrupting each other. `element.animate()` has no such constraint.
 */
export function animateIn(el: HTMLElement): void {
  if (prefersReducedMotion() || typeof el.animate !== "function") return;
  el.animate(ENTER, TIMING);
}

/**
 * Slide-and-fade the panel a newly selected tab reveals.
 *
 * `direction` is the travel of the selection rather than of the content: picking
 * a tab further along the list brings its panel in from the right.
 */
export function animateTabPanel(el: HTMLElement, direction: "next" | "previous"): void {
  if (prefersReducedMotion() || typeof el.animate !== "function") return;

  // Tabs can be switched faster than 180ms, and a half-finished transform would
  // otherwise become the start of the next animation.
  for (const animation of el.getAnimations()) animation.cancel();

  const easing =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--emphasized-curve")
      .trim() || "ease-out";

  el.animate(
    [
      { opacity: 0, transform: `translateX(${direction === "next" ? 8 : -8}px)` },
      { opacity: 1, transform: "translateX(0)" },
    ],
    { duration: 180, easing },
  );
}

/**
 * Play the leave animation and resolve when it is over.
 *
 * **Always resolves.** Callers gate a state change on this — removing the toast
 * — and `animation.finished` *rejects* when the animation is cancelled, which
 * happens routinely: the element is detached, the animation is replaced, the
 * document is hidden. An uncaught rejection there would leave the toast on
 * screen forever. Reduced motion and a missing `el.animate` return immediately
 * for the same reason: the caller must always get its turn.
 */
export async function animateOut(el: HTMLElement): Promise<void> {
  if (prefersReducedMotion() || typeof el.animate !== "function") return;
  try {
    await el.animate(EXIT, TIMING).finished;
  } catch {
    // Cancelled — the caller still needs to proceed.
  }
}
