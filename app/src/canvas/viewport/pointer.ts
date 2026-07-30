import type { CanvasPoint } from "./geometry.ts";

/**
 * Turning browser pointer events into canvas coordinates.
 *
 * Extracted from `Canvas.vue` (plan section 6). The viewport rectangle and the
 * screen-to-world projection are parameters rather than reads of component
 * state, which is also what makes the coalesced-sample path testable.
 */

export interface PointerSample<TEvent = PointerEvent> {
  event: TEvent;
  screen: CanvasPoint;
  world: CanvasPoint;
}

export interface PointerGesture<TEvent = PointerEvent> extends PointerSample<TEvent> {
  /** Every sample the browser coalesced into this event, oldest first. */
  samples: PointerSample<TEvent>[];
}

/**
 * Pointer position relative to the viewport.
 *
 * Takes a cached rect: `getBoundingClientRect` forces layout, and calling it
 * per pointer event during a drag is the difference between smooth and not.
 */
export function screenPoint(
  event: { clientX: number; clientY: number },
  viewportRect: { left: number; top: number } | null | undefined,
): CanvasPoint {
  return {
    x: event.clientX - (viewportRect?.left ?? 0),
    y: event.clientY - (viewportRect?.top ?? 0),
  };
}

export function pointerSample<TEvent extends { clientX: number; clientY: number }>(
  event: TEvent,
  viewportRect: { left: number; top: number } | null | undefined,
  screenToWorld: (point: CanvasPoint) => CanvasPoint,
): PointerSample<TEvent> {
  const screen = screenPoint(event, viewportRect);
  return { event, screen, world: screenToWorld(screen) };
}

/**
 * A gesture event carrying the full coalesced sample list.
 *
 * A pointer can move several times between frames; the browser delivers one
 * event with the intermediate positions attached. Freehand drawing needs all of
 * them or the stroke is visibly faceted, which is why this is not just the
 * latest position.
 */
export function pointerGesture(
  event: PointerEvent,
  viewportRect: { left: number; top: number } | null | undefined,
  screenToWorld: (point: CanvasPoint) => CanvasPoint,
): PointerGesture {
  const coalesced = event.getCoalescedEvents?.() ?? [];
  const source = coalesced.length > 0 ? coalesced : [event];
  return {
    ...pointerSample(event, viewportRect, screenToWorld),
    samples: source.map((sample) => pointerSample(sample, viewportRect, screenToWorld)),
  };
}

/** Releases a captured pointer, if this element still holds it. */
export function releasePointerCapture(
  target: Element | null | undefined,
  pointerId: number,
): void {
  if (target?.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
}
