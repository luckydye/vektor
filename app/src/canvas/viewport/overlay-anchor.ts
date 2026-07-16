import type { WorldTransform } from "./transform";
import type { Artboard } from "./types";

// ---------------------------------------------------------------------------
// Overlay anchors: attach HTML elements to positions in artboard space.
//
// The compositor draws *pixels* (tiles, selection chrome) onto the canvas. This
// primitive instead positions real DOM elements over the viewport so they can
// host interactive controls — a text-size picker above a text layer's bounding
// box, a delete button on a shape's corner, a label beside a point.
//
// An anchor is defined in artboard-local coordinates (the same space as a
// layer's bounding box). On every frame you call `sync(transform)` with the
// current world→screen transform and the layer repositions each element. The
// elements keep a constant screen size — they track the anchor's *position*,
// not the artboard's scale — which is what you want for control chrome.
// ---------------------------------------------------------------------------

// A rect (or point, when width/height are 0) in artboard-local coordinates,
// relative to a specific artboard. This is exactly the shape of a text layer's
// bounds, so an overlay can anchor directly to one.
export interface AnchorTarget {
  artboard: Artboard;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Where the element sits relative to its target rect. "top" places it above the
// top edge, horizontally centered; "bottom-right" hangs it off the BR corner;
// "center" overlays the middle. For full control, pass explicit fractions via
// AnchorOptions.anchor / .origin instead.
export type AnchorPlacement =
  | "center"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

// A normalized point in [0,1]² along a box's axes (0 = left/top, 1 = right/bottom).
export interface UnitPoint {
  x: number;
  y: number;
}

export interface AnchorOptions {
  // Named placement (default "top"). Resolved into `anchor`/`origin` fractions
  // below; explicit fractions override it.
  placement?: AnchorPlacement;
  // Point on the TARGET rect the element attaches to (overrides placement's anchor).
  anchor?: UnitPoint;
  // Point on the ELEMENT that lands on the anchor (overrides placement's origin).
  // e.g. origin {x:0.5,y:1} means the element's bottom-center sits on the anchor.
  origin?: UnitPoint;
  // Extra screen-pixel offset applied after placement — typically a gap.
  offset?: { x: number; y: number };
  // Hide the element while its anchor point is outside the viewport box.
  hideWhenOffscreen?: boolean;
  // CSS class(es) applied to the created element.
  className?: string;
}

// A live handle to one anchored element.
export interface Anchor {
  // The positioned element. Fill it with your own content / mount a framework
  // component into it. Do not set its `position`/`left`/`top`/`transform`
  // inline — the layer owns those.
  readonly element: HTMLElement;
  // Re-target the anchor to a different rect (e.g. when the layer's bounds change).
  setTarget(target: AnchorTarget): void;
  // Change placement/offset/etc. after creation. Merged with existing options.
  setOptions(options: AnchorOptions): void;
  setVisible(visible: boolean): void;
  // Detach from the DOM and stop tracking. Idempotent.
  remove(): void;
}

const PLACEMENTS: Record<AnchorPlacement, { anchor: UnitPoint; origin: UnitPoint }> = {
  center: { anchor: { x: 0.5, y: 0.5 }, origin: { x: 0.5, y: 0.5 } },
  top: { anchor: { x: 0.5, y: 0 }, origin: { x: 0.5, y: 1 } },
  bottom: { anchor: { x: 0.5, y: 1 }, origin: { x: 0.5, y: 0 } },
  left: { anchor: { x: 0, y: 0.5 }, origin: { x: 1, y: 0.5 } },
  right: { anchor: { x: 1, y: 0.5 }, origin: { x: 0, y: 0.5 } },
  "top-left": { anchor: { x: 0, y: 0 }, origin: { x: 1, y: 1 } },
  "top-right": { anchor: { x: 1, y: 0 }, origin: { x: 0, y: 1 } },
  "bottom-left": { anchor: { x: 0, y: 1 }, origin: { x: 1, y: 0 } },
  "bottom-right": { anchor: { x: 1, y: 1 }, origin: { x: 0, y: 0 } },
};

interface AnchorEntry {
  element: HTMLElement;
  target: AnchorTarget;
  options: Required<Omit<AnchorOptions, "className">>;
  visible: boolean;
  removed: boolean;
}

function resolveOptions(
  options: AnchorOptions,
): Required<Omit<AnchorOptions, "className">> {
  const placement = options.placement ?? "top";
  const preset = PLACEMENTS[placement];
  return {
    placement,
    anchor: options.anchor ?? preset.anchor,
    origin: options.origin ?? preset.origin,
    offset: options.offset ?? { x: 0, y: 0 },
    hideWhenOffscreen: options.hideWhenOffscreen ?? false,
  };
}

export interface AnchorLayer {
  // The container that overlays the canvas. Append it to the same positioned
  // parent as your <canvas> (it is `position:absolute; inset:0`). It does not
  // capture pointer events; individual anchored elements do.
  readonly root: HTMLElement;
  // Create an anchored element and return its handle.
  add(target: AnchorTarget, options?: AnchorOptions): Anchor;
  // Reposition every anchored element for the current transform. Call this each
  // frame, right where you call `compositeArtboard`.
  sync(transform: WorldTransform): void;
  // Remove all anchors and the root container.
  destroy(): void;
}

// Create an overlay layer. `doc` lets you target a specific document (e.g. an
// iframe); it defaults to the ambient `document`.
export function createAnchorLayer(doc: Document = document): AnchorLayer {
  const root = doc.createElement("div");
  root.style.position = "absolute";
  root.style.inset = "0";
  root.style.overflow = "hidden";
  // The container is a passthrough; only the controls inside it are interactive.
  root.style.pointerEvents = "none";

  const entries = new Set<AnchorEntry>();
  let lastTransform: WorldTransform | null = null;

  function position(entry: AnchorEntry, t: WorldTransform) {
    if (entry.removed) return;
    const { target, options } = entry;
    // Anchor point in artboard-local space → world → screen (CSS px).
    const localX = target.x + target.width * options.anchor.x;
    const localY = target.y + target.height * options.anchor.y;
    const sx = (target.artboard.worldX + localX) * t.scale + t.dx + options.offset.x;
    const sy = (target.artboard.worldY + localY) * t.scale + t.dy + options.offset.y;

    let onscreen = true;
    if (options.hideWhenOffscreen) {
      onscreen = sx >= 0 && sy >= 0 && sx <= root.clientWidth && sy <= root.clientHeight;
    }
    const show = entry.visible && onscreen;
    entry.element.style.display = show ? "" : "none";
    if (!show) return;

    // Place the element's `origin` point on the anchor. The percentage translate
    // is relative to the element's own size, so it stays a constant screen size
    // regardless of zoom — it tracks position, not scale.
    entry.element.style.transform =
      `translate(${sx}px, ${sy}px) ` +
      `translate(${-options.origin.x * 100}%, ${-options.origin.y * 100}%)`;
  }

  function add(target: AnchorTarget, options: AnchorOptions = {}): Anchor {
    const element = doc.createElement("div");
    element.style.position = "absolute";
    element.style.top = "0";
    element.style.left = "0";
    // Controls should be clickable even though the container isn't.
    element.style.pointerEvents = "auto";
    element.style.willChange = "transform";
    if (options.className) element.className = options.className;
    root.appendChild(element);

    const entry: AnchorEntry = {
      element,
      target,
      options: resolveOptions(options),
      visible: true,
      removed: false,
    };
    entries.add(entry);
    if (lastTransform) position(entry, lastTransform);

    return {
      element,
      setTarget(next) {
        entry.target = next;
        if (lastTransform) position(entry, lastTransform);
      },
      setOptions(next) {
        entry.options = resolveOptions({
          placement: next.placement ?? entry.options.placement,
          anchor: next.anchor ?? entry.options.anchor,
          origin: next.origin ?? entry.options.origin,
          offset: next.offset ?? entry.options.offset,
          hideWhenOffscreen: next.hideWhenOffscreen ?? entry.options.hideWhenOffscreen,
        });
        if (next.className !== undefined) element.className = next.className;
        if (lastTransform) position(entry, lastTransform);
      },
      setVisible(visible) {
        entry.visible = visible;
        if (lastTransform) position(entry, lastTransform);
      },
      remove() {
        if (entry.removed) return;
        entry.removed = true;
        entries.delete(entry);
        element.remove();
      },
    };
  }

  function sync(transform: WorldTransform) {
    lastTransform = transform;
    for (const entry of entries) position(entry, transform);
  }

  function destroy() {
    for (const entry of entries) {
      entry.removed = true;
      entry.element.remove();
    }
    entries.clear();
    root.remove();
  }

  return { root, add, sync, destroy };
}
