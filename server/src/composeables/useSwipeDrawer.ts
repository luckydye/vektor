import { type Accessor, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { lockScroll, unlockScroll } from "#utils/scrollLock.ts";

interface Options {
  /** The screen edge the drawer is attached to. */
  side: "left" | "right";
  width: Accessor<number>;
  isOpen: Accessor<boolean>;
  setOpen: (open: boolean) => void;
  onDragChange?: (offset: number | null) => void;
}

const DRAG_THRESHOLD = 8;
const ANDROID_BACK_GESTURE_INSET = 24;
const MOBILE_QUERY = "(max-width: 767px)";

// A swipe on the screen only opens a drawer while none is open, so the swipe
// that closes one drawer never opens the one on the other side.
const openDrawers = new Set<symbol>();

/**
 * Touch gestures for a mobile drawer: a horizontal swipe anywhere on the screen
 * pulls it in from its edge, a swipe back on the drawer pushes it out. The
 * offset is how far the drawer is revealed, from 0 to `width`.
 */
export function useSwipeDrawer(options: Options) {
  const id = Symbol(options.side);
  const direction = options.side === "left" ? 1 : -1;

  const [offset, setOffset] = createSignal(0);
  const [isDragging, setIsDragging] = createSignal(false);

  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startOffset = 0;

  function isAndroidBackGestureAt(clientX: number) {
    if (!/Android/i.test(navigator.userAgent)) return false;
    return options.side === "left"
      ? clientX < ANDROID_BACK_GESTURE_INSET
      : clientX > window.innerWidth - ANDROID_BACK_GESTURE_INSET;
  }

  function isGestureExcluded(e: TouchEvent) {
    return e.composedPath().some((target) => {
      if (!(target instanceof Element)) return false;
      if (target.matches("a-track, input[type='range'], [role='slider']")) return true;
      const { overflowX } = getComputedStyle(target);
      return (
        (overflowX === "auto" || overflowX === "scroll") &&
        target.scrollWidth > target.clientWidth
      );
    });
  }

  function start(e: TouchEvent, fromOffset: number) {
    const touch = e.changedTouches[0];
    if (
      !touch ||
      e.touches.length !== 1 ||
      !window.matchMedia(MOBILE_QUERY).matches ||
      isGestureExcluded(e)
    ) {
      return;
    }
    pointerId = touch.identifier;
    startX = touch.clientX;
    startY = touch.clientY;
    startOffset = fromOffset;
    setOffset(fromOffset);
    setIsDragging(false);
  }

  function startFromScreen(e: TouchEvent) {
    const touch = e.changedTouches[0];
    if (!touch || openDrawers.size > 0 || isAndroidBackGestureAt(touch.clientX)) return;
    start(e, 0);
  }

  /** Touch start handler for the drawer and the uncovered area beside it. */
  function startFromDrawer(e: TouchEvent) {
    if (options.isOpen()) start(e, options.width());
  }

  function trackedTouch(e: TouchEvent) {
    for (let index = 0; index < e.changedTouches.length; index += 1) {
      const touch = e.changedTouches.item(index);
      if (touch?.identifier === pointerId) return touch;
    }
    return null;
  }

  function cancel() {
    pointerId = null;
    if (!isDragging()) return;
    setIsDragging(false);
    options.onDragChange?.(null);
    options.setOpen(options.isOpen());
  }

  function move(e: TouchEvent) {
    const touch = trackedTouch(e);
    if (!touch) return;

    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    const isOpening = startOffset === 0;
    const isTowardsTarget = direction * deltaX * (isOpening ? 1 : -1) > 0;

    if (isTowardsTarget && Math.abs(deltaX) > Math.abs(deltaY)) {
      if (!e.cancelable) {
        cancel();
        return;
      }
      e.preventDefault();
    }

    if (!isDragging()) {
      if (Math.abs(deltaY) > DRAG_THRESHOLD && Math.abs(deltaY) > Math.abs(deltaX)) {
        pointerId = null;
        return;
      }
      if (Math.abs(deltaX) < DRAG_THRESHOLD) return;
      if (!isTowardsTarget) {
        pointerId = null;
        return;
      }
      setIsDragging(true);
    }

    setOffset(Math.max(0, Math.min(options.width(), startOffset + direction * deltaX)));
    options.onDragChange?.(offset());
  }

  function end(e: TouchEvent) {
    if (!trackedTouch(e)) return;
    pointerId = null;
    if (!isDragging()) return;

    setIsDragging(false);
    options.onDragChange?.(null);
    options.setOpen(offset() >= options.width() / 2);
  }

  /** The drawer's transform while it follows a finger. */
  const transform = () => {
    if (!isDragging()) return undefined;
    const hidden = options.width() - offset();
    return `translateX(${direction * -hidden}px)`;
  };

  let holdsScrollLock = false;
  function applyOpenState(open: boolean) {
    if (open) openDrawers.add(id);
    else openDrawers.delete(id);

    if (open && !holdsScrollLock) {
      lockScroll();
      holdsScrollLock = true;
    } else if (!open && holdsScrollLock) {
      unlockScroll();
      holdsScrollLock = false;
    }
  }

  createEffect(() => applyOpenState(options.isOpen()));

  onMount(() => {
    document.addEventListener("touchstart", startFromScreen, { capture: true });
    document.addEventListener("touchmove", move, { capture: true, passive: false });
    document.addEventListener("touchend", end, { capture: true });
    document.addEventListener("touchcancel", end, { capture: true });

    onCleanup(() => {
      document.removeEventListener("touchstart", startFromScreen, true);
      document.removeEventListener("touchmove", move, true);
      document.removeEventListener("touchend", end, true);
      document.removeEventListener("touchcancel", end, true);
      applyOpenState(false);
    });
  });

  return { offset, isDragging, transform, startFromDrawer };
}
