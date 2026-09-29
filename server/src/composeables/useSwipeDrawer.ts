import { type Accessor, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { lockScroll, unlockScroll } from "#utils/scrollLock.ts";

interface Options {
  /** The screen edge the drawer is attached to. */
  side: "left" | "right" | "bottom";
  /** The drawer's extent along the swipe axis. */
  size: Accessor<number>;
  isOpen: Accessor<boolean>;
  setOpen: (open: boolean) => void;
  /**
   * Opens the drawer on a swipe anywhere on the screen. Such a drawer also locks
   * page scroll while open and keeps other drawers from opening by screen swipe.
   */
  openFromScreen?: boolean;
}

interface Sample {
  time: number;
  offset: number;
}

const DRAG_THRESHOLD = 8;
const ANDROID_BACK_GESTURE_INSET = 24;
const MOBILE_QUERY = "(max-width: 767px)";

// Only the finger's movement in this window before release counts towards its speed.
const VELOCITY_WINDOW = 80;
// Above this speed (px/ms) the swipe's direction decides, not how far it got.
const FLING_VELOCITY = 0.4;
// The release curve starts at RELEASE_SLOPE times its average speed, so the
// duration is picked to make that initial speed the finger's.
const RELEASE_CURVE = "cubic-bezier(0.25, 0.75, 0.5, 1)";
const RELEASE_SLOPE = 3;
const MIN_RELEASE_DURATION = 120;
const MAX_RELEASE_DURATION = 300;

// A swipe on the screen only opens a drawer while none is open, so the swipe
// that closes one drawer never opens the one on the other side.
const openDrawers = new Set<symbol>();

interface Shift {
  /** px the drawer pushes the page by, positive to the right. */
  shift: number;
  isDragging: boolean;
}

// Replaced rather than mutated on every write: `Map.set` is invisible to a signal.
const [shifts, setShifts] = createSignal<ReadonlyMap<symbol, Shift>>(new Map());

function writeShift(id: symbol, shift: Shift | null) {
  const next = new Map(shifts());
  if (shift) next.set(id, shift);
  else next.delete(id);
  setShifts(next);
}

/** How far the side drawers push the page aside, for the page's parallax. */
export function useDrawerShift() {
  return {
    shift: () => [...shifts().values()].reduce((sum, entry) => sum + entry.shift, 0),
    isDragging: () => [...shifts().values()].some((entry) => entry.isDragging),
  };
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/**
 * Touch gestures for a mobile drawer: a swipe pulls it in from its edge, a
 * swipe back on the drawer pushes it out. A flick carries on at the finger's
 * speed. The offset is how far the drawer is revealed, from 0 to `size`.
 */
export function useSwipeDrawer(options: Options) {
  const id = Symbol(options.side);
  const axis = options.side === "bottom" ? "y" : "x";
  // The sign of a movement along the axis that reveals the drawer.
  const direction = options.side === "left" ? 1 : -1;

  const [offset, setOffset] = createSignal(0);
  const [isDragging, setIsDragging] = createSignal(false);
  const [releaseTransition, setReleaseTransition] = createSignal<string>();

  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startOffset = 0;
  let samples: Sample[] = [];

  function isAndroidBackGestureAt(clientX: number) {
    if (!/Android/i.test(navigator.userAgent)) return false;
    return options.side === "left"
      ? clientX < ANDROID_BACK_GESTURE_INSET
      : clientX > window.innerWidth - ANDROID_BACK_GESTURE_INSET;
  }

  /** Content that takes the swipe itself: sliders, and scroll containers along the axis. */
  function isGestureExcluded(e: TouchEvent) {
    return e.composedPath().some((target) => {
      if (!(target instanceof Element)) return false;
      if (target.matches("a-track, input[type='range'], [role='slider']")) return true;
      const style = getComputedStyle(target);
      if (axis === "x") {
        return (
          (style.overflowX === "auto" || style.overflowX === "scroll") &&
          target.scrollWidth > target.clientWidth
        );
      }
      // Scrolled down, a downward swipe scrolls back up before it drags the drawer.
      return (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        target.scrollTop > 0
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
    samples = [];
    setOffset(fromOffset);
    setIsDragging(false);
    setReleaseTransition(undefined);
  }

  function startFromScreen(e: TouchEvent) {
    const touch = e.changedTouches[0];
    if (!touch || openDrawers.size > 0 || isAndroidBackGestureAt(touch.clientX)) return;
    start(e, 0);
  }

  /** Touch start handler for the drawer and the uncovered area beside it. */
  function startFromDrawer(e: TouchEvent) {
    if (options.isOpen()) start(e, options.size());
  }

  function trackedTouch(e: TouchEvent) {
    for (let index = 0; index < e.changedTouches.length; index += 1) {
      const touch = e.changedTouches.item(index);
      if (touch?.identifier === pointerId) return touch;
    }
    return null;
  }

  function sample(time: number) {
    samples.push({ time, offset: offset() });
    while (samples.length > 2 && time - samples[0].time > VELOCITY_WINDOW) {
      samples.shift();
    }
  }

  /** The finger's speed at release in px/ms, positive towards revealing the drawer. */
  function releaseVelocity(time: number) {
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first || !last || last.time === first.time) return 0;
    // A finger that came to rest before lifting has no speed left.
    if (time - last.time > VELOCITY_WINDOW) return 0;
    return (last.offset - first.offset) / (last.time - first.time);
  }

  function cancel() {
    pointerId = null;
    if (!isDragging()) return;
    setIsDragging(false);
    options.setOpen(options.isOpen());
  }

  function move(e: TouchEvent) {
    const touch = trackedTouch(e);
    if (!touch) return;

    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    const along = axis === "x" ? deltaX : deltaY;
    const across = axis === "x" ? deltaY : deltaX;
    const isOpening = startOffset === 0;
    const isTowardsTarget = direction * along * (isOpening ? 1 : -1) > 0;

    if (isTowardsTarget && Math.abs(along) > Math.abs(across)) {
      if (!e.cancelable) {
        cancel();
        return;
      }
      e.preventDefault();
    }

    if (!isDragging()) {
      if (Math.abs(across) > DRAG_THRESHOLD && Math.abs(across) > Math.abs(along)) {
        pointerId = null;
        return;
      }
      if (Math.abs(along) < DRAG_THRESHOLD) return;
      if (!isTowardsTarget) {
        pointerId = null;
        return;
      }
      setIsDragging(true);
    }

    setOffset(clamp(startOffset + direction * along, 0, options.size()));
    sample(e.timeStamp);
  }

  function end(e: TouchEvent) {
    if (!trackedTouch(e)) return;
    pointerId = null;
    if (!isDragging()) return;

    const size = options.size();
    const velocity = releaseVelocity(e.timeStamp);
    const open =
      Math.abs(velocity) > FLING_VELOCITY ? velocity > 0 : offset() >= size / 2;
    const distance = open ? size - offset() : offset();
    const speed = open ? velocity : -velocity;
    const duration =
      speed > 0
        ? clamp((RELEASE_SLOPE * distance) / speed, MIN_RELEASE_DURATION, MAX_RELEASE_DURATION)
        : MAX_RELEASE_DURATION;

    setReleaseTransition(`translate ${Math.round(duration)}ms ${RELEASE_CURVE}`);
    setIsDragging(false);
    options.setOpen(open);
  }

  /** The drawer's CSS `translate` while it follows a finger. */
  const translate = () => {
    if (!isDragging()) return undefined;
    const shift = -direction * (options.size() - offset());
    return axis === "x" ? `${shift}px 0` : `0 ${shift}px`;
  };

  /** The drawer's CSS `transition`: none while dragged, the finger's speed once let go. */
  const transition = () => (isDragging() ? "none" : releaseTransition());

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

  if (options.openFromScreen) {
    createEffect(() => applyOpenState(options.isOpen()));
  }

  if (axis === "x") {
    createEffect(() => {
      const revealed = isDragging() ? offset() : options.isOpen() ? options.size() : 0;
      writeShift(id, { shift: direction * revealed, isDragging: isDragging() });
    });
  }

  onMount(() => {
    if (options.openFromScreen) {
      document.addEventListener("touchstart", startFromScreen, { capture: true });
    }
    document.addEventListener("touchmove", move, { capture: true, passive: false });
    document.addEventListener("touchend", end, { capture: true });
    document.addEventListener("touchcancel", end, { capture: true });

    onCleanup(() => {
      document.removeEventListener("touchstart", startFromScreen, true);
      document.removeEventListener("touchmove", move, true);
      document.removeEventListener("touchend", end, true);
      document.removeEventListener("touchcancel", end, true);
      applyOpenState(false);
      writeShift(id, null);
    });
  });

  return { offset, isDragging, translate, transition, startFromDrawer };
}
